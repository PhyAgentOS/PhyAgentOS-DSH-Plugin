import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

import { ErrorCode } from './errors.js'
import { parseManifest, type ForgeIssue, type ForgeManifest } from './manifest.js'

/** A bundle that parsed cleanly and is therefore addressable. */
export interface ForgeSkillEntry {
  readonly name: string
  readonly dir: string
  readonly manifest: ForgeManifest
}

/** A bundle that could not be used, kept so the doctor can explain why. */
export interface ForgeDiagnostic {
  readonly name: string
  readonly dir: string
  readonly code: string
  readonly message: string
  readonly issues: readonly ForgeIssue[]
}

/** Result of one catalog scan. */
export interface CatalogListing {
  readonly skills: readonly ForgeSkillEntry[]
  readonly diagnostics: readonly ForgeDiagnostic[]
}

/** One row of `forge_skill_inspect` / `forge_skill_doctor` output. */
export interface ForgeCheck {
  readonly id: string
  readonly status: 'pass' | 'warn' | 'fail'
  readonly detail: string
}

/** Static inspection result for one bundle. */
export interface ForgeInspection {
  readonly entry: ForgeSkillEntry
  readonly checks: readonly ForgeCheck[]
}

const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/

/** Forge runtime major implemented by this plugin (dora 0.4.1, artifact runtime). */
export const SUPPORTED_FORGE_VERSION = '1'

/**
 * Read-only view over one or more skill roots.
 *
 * The catalog never caches: every `list()` re-reads manifests so that a caller
 * which invalidates on directory changes always sees the current disk state.
 */
export class ForgeCatalog {
  constructor(readonly root: string) {}

  /** Scan every bundle directly under the root. Nested bundles are intentionally unsupported. */
  async list(): Promise<CatalogListing> {
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if (isMissing(error)) return { skills: [], diagnostics: [] }
      throw error
    }

    const skills: ForgeSkillEntry[] = []
    const diagnostics: ForgeDiagnostic[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const dir = join(this.root, entry.name)
      const text = await readIfExists(join(dir, 'skill.yaml'))
      if (text === undefined) {
        diagnostics.push({
          name: entry.name,
          dir,
          code: ErrorCode.manifestInvalid,
          message: 'skill.yaml is missing',
          issues: [{ path: 'skill.yaml', code: ErrorCode.manifestInvalid, message: 'file not found' }],
        })
        continue
      }
      const parsed = parseManifest(text, `skills/${entry.name}/skill.yaml`)
      if (parsed.manifest === undefined) {
        const first = parsed.issues[0]
        diagnostics.push({
          name: entry.name,
          dir,
          code: first?.code ?? ErrorCode.manifestInvalid,
          message: first === undefined ? 'manifest is invalid' : `${first.path}: ${first.message}`,
          issues: parsed.issues,
        })
        continue
      }
      skills.push({ name: parsed.manifest.name, dir, manifest: parsed.manifest })
    }
    return { skills, diagnostics }
  }

  /** Load one bundle by its manifest name. */
  async load(name: string): Promise<ForgeSkillEntry | undefined> {
    if (!SAFE_NAME.test(name)) return undefined
    const dir = join(this.root, name)
    const text = await readIfExists(join(dir, 'skill.yaml'))
    if (text === undefined) return undefined
    const parsed = parseManifest(text, `skills/${name}/skill.yaml`)
    if (parsed.manifest === undefined) return undefined
    return { name: parsed.manifest.name, dir, manifest: parsed.manifest }
  }

  /** Read the instruction document of one bundle. */
  async readDocument(name: string): Promise<string | undefined> {
    const entry = await this.load(name)
    if (entry === undefined) return undefined
    return readIfExists(join(entry.dir, entry.manifest.skillDocument))
  }

  /** Static structural check: documents, dataflows, assets and artifact locks. */
  async inspect(name: string): Promise<ForgeInspection | undefined> {
    const entry = await this.load(name)
    if (entry === undefined) return undefined
    const { manifest, dir } = entry
    const checks: ForgeCheck[] = []

    const document = join(dir, manifest.skillDocument)
    checks.push(await fileCheck('skill_document', document))
    const forgeVersion = manifest.forgeVersion ?? '1'
    checks.push({
      id: 'forge_version',
      status: forgeVersion === SUPPORTED_FORGE_VERSION ? 'pass' : 'fail',
      detail: forgeVersion === SUPPORTED_FORGE_VERSION
        ? `Forge ${forgeVersion}`
        : `bundle targets Forge ${forgeVersion}; this build implements Forge ${SUPPORTED_FORGE_VERSION} (dora 0.4.1)`,
    })

    for (const profile of Object.values(manifest.profiles)) {
      checks.push(await fileCheck(`profile.${profile.id}.dataflow`, join(dir, profile.dataflow)))
      for (const asset of profile.requiredAssets) {
        checks.push(await fileCheck(`profile.${profile.id}.asset.${asset}`, join(dir, asset)))
      }
      const missingLocks = profile.requiredBinaries.filter(binary => manifest.artifacts[binary] === undefined)
      checks.push({
        id: `profile.${profile.id}.artifact_locks`,
        status: missingLocks.length === 0 ? 'pass' : 'fail',
        detail: missingLocks.length === 0
          ? `${profile.requiredBinaries.length} binaries locked`
          : `no artifact lock for: ${missingLocks.join(', ')}`,
      })
    }

    return { entry, checks }
  }
}

async function fileCheck(id: string, path: string): Promise<ForgeCheck> {
  try {
    const info = await stat(path)
    return { id, status: info.isFile() ? 'pass' : 'warn', detail: path }
  } catch (error) {
    if (isMissing(error)) return { id, status: 'fail', detail: `${path} is missing` }
    return { id, status: 'fail', detail: `${path}: ${(error as Error).message}` }
  }
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: string }).code === 'ENOENT'
}
