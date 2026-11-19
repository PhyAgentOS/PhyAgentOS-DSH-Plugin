import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { c as createTar } from 'tar'

import { ForgeError } from './errors.js'

/**
 * Directory parts that never belong in a distributable bundle: VCS metadata,
 * build caches, and runtime state the target rebuilds.
 */
const EXCLUDED_PARTS = new Set([
  '.git',
  '.hg',
  '.svn',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'node_modules',
  'build',
])

export interface PackageSkillOptions {
  /** Bundle directory to package; its basename must equal the manifest skill name. */
  readonly bundleDir: string
  /** Directory that receives `<name>-<version>.tar.gz` plus a `.sha256` sidecar. */
  readonly outputDir: string
  /** Replace an existing archive instead of failing. */
  readonly force?: boolean
  /**
   * Ship `venv` trees as well. Off by default: a venv embeds absolute paths and
   * must be rebuilt on the target (see the bundle's `support/setup.sh`).
   */
  readonly includeVenv?: boolean
}

export interface PackageSkillResult {
  readonly ok: true
  readonly name: string
  readonly version: string
  readonly archivePath: string
  readonly sha256: string
  readonly bytes: number
  readonly files: number
  readonly excludedVenv: boolean
}

interface PayloadFile {
  readonly path: string
  readonly size: number
  readonly sha256: string
}

const MANIFEST_NAME = 'archive-manifest.json'

function safeIdentity(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ForgeError('FORGE_PACKAGE_INVALID', `${label} must be a non-empty string`)
  }
  const trimmed = value.trim()
  if (trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new ForgeError('FORGE_PACKAGE_INVALID', `${label} must be a directory-safe name`)
  }
  return trimmed
}

/** Top-level `name`/`version` scalars are all the packager needs from the manifest. */
async function readIdentity(bundleDir: string): Promise<{ name: string; version: string }> {
  let text: string
  try {
    text = await readFile(join(bundleDir, 'skill.yaml'), 'utf8')
  } catch {
    throw new ForgeError('FORGE_PACKAGE_INVALID', 'bundle has no skill.yaml')
  }
  const scalars: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith(' ') || line.startsWith('\t') || line.startsWith('#')) continue
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    const raw = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '')
    if (raw.length > 0 && (key === 'name' || key === 'version')) scalars[key] = raw
  }
  const name = safeIdentity(scalars['name'], 'skill.yaml name')
  const version = safeIdentity(scalars['version'], 'skill.yaml version')
  try {
    await stat(join(bundleDir, 'SKILL.md'))
  } catch {
    throw new ForgeError('FORGE_PACKAGE_INVALID', 'bundle has no SKILL.md')
  }
  return { name, version }
}

function isExcluded(parts: readonly string[], includeVenv: boolean): boolean {
  if (parts.some(part => EXCLUDED_PARTS.has(part))) return true
  if (parts.some(part => part.endsWith('.egg-info'))) return true
  return includeVenv ? false : parts.includes('venv')
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer)
  return hash.digest('hex')
}

/**
 * Walk the bundle and collect the payload.
 *
 * Symlinks are refused rather than followed: the installer rejects them, so a
 * bundle containing one could never be installed and must fail here instead of
 * producing an archive that only breaks later.
 */
async function collect(bundleDir: string, includeVenv: boolean): Promise<PayloadFile[]> {
  const files: PayloadFile[] = []
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const absolute = join(dir, entry.name)
      const parts = relative(bundleDir, absolute).split(sep)
      if (isExcluded(parts, includeVenv)) continue
      const info = await lstat(absolute)
      if (info.isSymbolicLink()) {
        throw new ForgeError(
          'FORGE_PACKAGE_INVALID',
          `symlinks are not allowed in a bundle: ${parts.join('/')}`,
        )
      }
      if (info.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!info.isFile()) continue
      if (parts.join('/') === MANIFEST_NAME) continue
      files.push({ path: parts.join('/'), size: info.size, sha256: await sha256File(absolute) })
    }
  }
  await walk(bundleDir)
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  if (files.length === 0) {
    throw new ForgeError('FORGE_PACKAGE_INVALID', 'bundle contains no payload files')
  }
  return files
}

/**
 * Package one skill bundle as a deterministic, self-describing `tar.gz`.
 *
 * Determinism is a feature, not an accident: identical input must produce an
 * identical sha256 so a lock file can be reviewed and re-verified. Entries are
 * sorted, `portable` mode pins uid/gid/uname/gname and clamps modes, and every
 * header timestamp is pinned to the epoch.
 *
 * The archive root is `<skill-name>/`, which is what the installer extracts, and
 * `archive-manifest.json` at the root records the size and sha256 of every
 * payload file so a hand-delivered bundle can be verified without a registry.
 */
export async function packageSkill(options: PackageSkillOptions): Promise<PackageSkillResult> {
  const bundleDir = options.bundleDir.replace(/[\\/]+$/, '')
  const { name, version } = await readIdentity(bundleDir)
  if (bundleDir.split(/[\\/]/).at(-1) !== name) {
    throw new ForgeError(
      'FORGE_PACKAGE_INVALID',
      `bundle directory must be named "${name}" so the archive root matches the skill name`,
    )
  }
  const outputDir = options.outputDir
  if (outputDir.trim().length === 0) {
    throw new ForgeError('FORGE_PACKAGE_INVALID', 'an output directory is required')
  }
  await mkdir(outputDir, { recursive: true })
  const archivePath = join(outputDir, `${name}-${version}.tar.gz`)
  const existing = await stat(archivePath).catch(() => undefined)
  if (existing !== undefined && options.force !== true) {
    throw new ForgeError('FORGE_PACKAGE_EXISTS', `${archivePath} already exists; pass force to replace it`)
  }

  const files = await collect(bundleDir, options.includeVenv === true)
  const excludedVenv = !options.includeVenv && (await stat(join(bundleDir, 'support', 'venv')).catch(() => undefined)) !== undefined

  // The manifest lives inside the archive root, so write it into the bundle for
  // the duration of the tar call and remove it again afterwards.
  const manifestPath = join(bundleDir, MANIFEST_NAME)
  const manifest = JSON.stringify({
    schema_version: 1,
    files: files.map(file => ({ path: file.path, size: file.size, sha256: file.sha256 })),
  })
  await writeFile(manifestPath, manifest, 'utf8')

  const staging = `${archivePath}.partial-${process.pid}`
  await rm(staging, { force: true })
  try {
    const directories = [
      ...new Set(
        files
          .map(file => (file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''))
          .filter(directory => directory.length > 0),
      ),
    ].sort()
    const entries = [
      ...directories.map(directory => `./${directory}`),
      ...files.map(file => `./${file.path}`),
      `./${MANIFEST_NAME}`,
    ]
    await createTar(
      {
        cwd: bundleDir,
        file: staging,
        portable: true,
        noDirRecurse: true,
        mtime: new Date(0),
        gzip: { level: 9 },
        prefix: name,
        // Fixed ordering and a pinned header timestamp per entry keep the digest stable.
        onWriteEntry(entry) {
          entry.mtime = new Date(0)
        },
      },
      entries,
    )
    await rename(staging, archivePath)
  } finally {
    await rm(staging, { force: true })
    await rm(manifestPath, { force: true })
  }

  const sha256 = await sha256File(archivePath)
  const { size } = await stat(archivePath)
  await writeFile(`${archivePath}.sha256`, `${sha256}  ${name}-${version}.tar.gz\n`, 'utf8')
  return {
    ok: true,
    name,
    version,
    archivePath,
    sha256,
    bytes: size,
    files: files.length + 1,
    excludedVenv,
  }
}