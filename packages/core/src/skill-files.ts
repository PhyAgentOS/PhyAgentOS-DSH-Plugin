import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'

import type { ForgeCatalog } from './catalog.js'
import { ForgeError } from './errors.js'

/** One editable file inside a skill profile directory. */
export interface ProfileFile {
  readonly path: string
  readonly size: number
  readonly modified: string
}

/** One profile of one installed skill, with its editable files. */
export interface SkillProfileTree {
  readonly id: string
  readonly files: readonly ProfileFile[]
}

/** One installed skill and its profiles. */
export interface SkillTree {
  readonly name: string
  readonly version: string
  readonly profiles: readonly SkillProfileTree[]
}

const EDITABLE = /\.(ya?ml|json|txt|md)$/i

/**
 * Read and write the files under `profiles/<id>/` of an installed skill.
 *
 * Only profile-scoped files are exposed; `skill.yaml` and `SKILL.md` are owned
 * by the bundle installer and stay read-only here. Every write is validated
 * (YAML must parse) and the previous file is copied aside first.
 */
export class SkillFileStore {
  constructor(private readonly catalog: ForgeCatalog, private readonly backupsRoot?: string) {}

  /** Enumerate installed skills, their profiles and editable files. */
  async tree(): Promise<SkillTree[]> {
    const { skills } = await this.catalog.list()
    const result: SkillTree[] = []
    for (const entry of skills) {
      const profiles: SkillProfileTree[] = []
      for (const id of Object.keys(entry.manifest.profiles)) {
        const dir = join(entry.dir, 'profiles', id)
        const files: ProfileFile[] = []
        for (const path of await walk(dir)) {
          const info = await stat(path)
          files.push({ path: relative(dir, path).split(sep).join('/'), size: info.size, modified: info.mtime.toISOString() })
        }
        profiles.push({ id, files: files.sort((left, right) => left.path.localeCompare(right.path)) })
      }
      result.push({ name: entry.name, version: entry.manifest.version, profiles })
    }
    return result
  }

  /** Bundle-level documentation: docs/** plus the root instruction and manifest files. */
  async bundleDocs(skill: string): Promise<ProfileFile[]> {
    const entry = await this.catalog.load(skill)
    if (entry === undefined) throw new ForgeError('FORGE_SKILL_NOT_FOUND', `skill "${skill}" is not installed`)
    const files: ProfileFile[] = []
    for (const name of ['SKILL.md', 'skill.yaml', 'README.md']) {
      const path = join(entry.dir, name)
      try {
        const info = await stat(path)
        files.push({ path: name, size: info.size, modified: info.mtime.toISOString() })
      } catch {
        // optional
      }
    }
    for (const path of await walk(join(entry.dir, 'docs'))) {
      const info = await stat(path)
      files.push({ path: `docs/${relative(join(entry.dir, 'docs'), path).split(sep).join('/')}`, size: info.size, modified: info.mtime.toISOString() })
    }
    return files.sort((left, right) => left.path.localeCompare(right.path))
  }

  /** Read one bundle document (docs/**, SKILL.md, skill.yaml, README.md). */
  async readBundleDoc(skill: string, file: string): Promise<string> {
    const entry = await this.catalog.load(skill)
    if (entry === undefined) throw new ForgeError('FORGE_SKILL_NOT_FOUND', `skill "${skill}" is not installed`)
    const allowed = file === 'SKILL.md' || file === 'skill.yaml' || file === 'README.md' || file.startsWith('docs/')
    if (!allowed) throw new ForgeError('FORGE_FILE_INVALID', `${file} is not a bundle document`)
    const target = resolve(entry.dir, file)
    if (!target.startsWith(resolve(entry.dir) + sep)) throw new ForgeError('FORGE_FILE_INVALID', 'path escapes the bundle')
    try {
      return await readFile(target, 'utf8')
    } catch {
      throw new ForgeError('FORGE_FILE_INVALID', `${file} does not exist`)
    }
  }

  /** Read one profile file. */
  async read(skill: string, profile: string, file: string): Promise<string> {
    return readFile(await this.resolve(skill, profile, file), 'utf8')
  }

  /** Validate and write one profile file, returning the backup path. */
  async write(skill: string, profile: string, file: string, content: string): Promise<{ path: string; backup: string }> {
    const path = await this.resolve(skill, profile, file)
    if (/\.ya?ml$/i.test(file)) {
      try {
        parseYaml(content)
      } catch (error) {
        throw new ForgeError('FORGE_FILE_INVALID', `${file}: ${(error as Error).message}`)
      }
    }
    const backup = await this.backupPath(path)
    await copyFile(path, backup)
    const temp = `${path}.tmp-${process.pid}`
    await writeFile(temp, content)
    await rename(temp, path)
    return { path, backup }
  }

  /** Backups live outside the bundle unless no dedicated root was configured. */
  private async backupPath(path: string): Promise<string> {
    if (this.backupsRoot === undefined) return `${path}.bak-${Date.now()}`
    const target = join(this.backupsRoot, String(Date.now()), path.split(sep).slice(-4).join(sep))
    await mkdir(join(target, '..'), { recursive: true })
    return target
  }

  private async resolve(skill: string, profile: string, file: string): Promise<string> {
    const entry = await this.catalog.load(skill)
    if (entry === undefined) throw new ForgeError('FORGE_SKILL_NOT_FOUND', `skill "${skill}" is not installed`)
    if (entry.manifest.profiles[profile] === undefined) {
      throw new ForgeError('FORGE_PROFILE_UNKNOWN', `profile "${profile}" does not exist`)
    }
    const root = resolve(entry.dir, 'profiles', profile)
    const target = resolve(root, file)
    if (!target.startsWith(root + sep)) throw new ForgeError('FORGE_FILE_INVALID', 'path escapes the profile directory')
    if (!EDITABLE.test(target)) throw new ForgeError('FORGE_FILE_INVALID', 'file type is not editable')
    try {
      await stat(target)
    } catch {
      throw new ForgeError('FORGE_FILE_INVALID', `${file} does not exist`)
    }
    return target
  }
}

async function walk(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const paths: string[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const path = join(dir, entry.name)
    if (entry.isDirectory()) paths.push(...await walk(path))
    else if (entry.isFile() && EDITABLE.test(entry.name)) paths.push(path)
  }
  return paths
}
