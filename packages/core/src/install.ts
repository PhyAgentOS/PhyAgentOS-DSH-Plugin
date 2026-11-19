import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { extractArchive } from './archive.js'
import { downloadFile } from './download.js'

import { ForgeError } from './errors.js'
import { parseManifest } from './manifest.js'
import type { ForgeRegistryClient, RegistryArtifact } from './registry.js'

/** Result of one install. */
export interface InstallResult {
  readonly name: string
  readonly version?: string
  readonly path: string
  readonly downloaded: boolean
  readonly bytes: number
}

export interface InstallOptions {
  readonly registry: ForgeRegistryClient
  readonly skillsRoot: string
  readonly cacheRoot: string
  readonly signal?: AbortSignal | undefined
  /** Pin a published version instead of the current one. */
  readonly version?: string | undefined
  /** Phase and byte progress for long transfers. */
  readonly onProgress?: ((phase: string, downloaded?: number, total?: number) => void) | undefined
}

/**
 * Install (or replace) one skill bundle transactionally.
 *
 * The bundle is downloaded to a content-addressed cache, digest-checked,
 * extracted into a staging directory, validated, then swapped into place with
 * the previous version kept aside until the rename succeeds.
 */
export async function installSkill(name: string, options: InstallOptions): Promise<InstallResult> {
  options.onProgress?.('resolve')
  const artifact = await options.registry.skill(name, options.version)
  const archive = await fetchArchive(artifact, options)
  await mkdir(options.skillsRoot, { recursive: true })
  const staging = await mkdtemp(join(options.skillsRoot, `.staging-${slug(name)}-`))
  const target = join(options.skillsRoot, name)
  const backup = `${target}.old-${Date.now()}`
  try {
    await extractArchive(archive.path, staging)
    const manifestText = await readManifestFile(staging)
    const parsed = parseManifest(manifestText, `skills/${name}/skill.yaml`)
    if (parsed.manifest === undefined) {
      const first = parsed.issues[0]
      throw new ForgeError('FORGE_MANIFEST_INVALID', first === undefined ? 'manifest is invalid' : `${first.path}: ${first.message}`)
    }
    if (parsed.manifest.name !== name) {
      throw new ForgeError('FORGE_MANIFEST_INVALID', `bundle name "${parsed.manifest.name}" does not match requested "${name}"`)
    }
    if (options.version !== undefined && parsed.manifest.version !== options.version) {
      throw new ForgeError('FORGE_MANIFEST_INVALID', `registry served version ${parsed.manifest.version}, requested ${options.version}`)
    }

    await rm(backup, { recursive: true, force: true })
    let hadPrevious = false
    try {
      await stat(target)
      hadPrevious = true
    } catch {
      hadPrevious = false
    }
    if (hadPrevious) await rename(target, backup)
    try {
      await rename(staging, target)
    } catch (error) {
      if (hadPrevious) await rename(backup, target).catch(() => undefined)
      throw error
    }
    await rm(backup, { recursive: true, force: true })

    return {
      name,
      version: parsed.manifest.version,
      path: target,
      downloaded: artifact.sha256 === undefined || !archive.fromCache,
      bytes: archive.bytes,
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

export interface LocalInstallOptions {
  /** Skill root that receives `<name>/`. */
  readonly skillsRoot: string
  /** Called with coarse phase names so a caller can log progress. */
  readonly onProgress?: ((phase: string) => void) | undefined
  /**
   * Names whose runtime is currently active. A running skill is not replaced:
   * its node processes hold the installed files, so swapping them would leave a
   * live flow pointing at a half-replaced bundle.
   */
  readonly running?: readonly string[]
}

export interface LocalInstallResult {
  readonly name: string
  readonly version: string
  readonly path: string
  readonly bytes: number
  /** Bytes of the replaced bundle, when a previous installation existed. */
  readonly replaced?: number
}

/**
 * Install a **local** `tar.gz` produced by `forge_skill_package`.
 *
 * Deliberately mirrors the registry path's guarantees instead of copying files
 * around: extract to a staging directory, require `skill.yaml` + `SKILL.md` at
 * the archive root, require the directory name to match the manifest name,
 * refuse to replace a running skill, keep the previous bundle under
 * `.backups/<name>/<version>-<stamp>` inside the skills root, and swap
 * atomically with a rollback.
 *
 * The archive digest is not verified: the caller passed a path, not a registry
 * artefact, so there is no trusted digest to compare against. Validation is
 * structural (`parseManifest` + the same checks the registry path runs).
 */
export async function installFromArchive(
  archivePath: string,
  options: LocalInstallOptions,
): Promise<LocalInstallResult> {
  const source = resolve(archivePath)
  let info
  try {
    info = await stat(source)
  } catch {
    throw new ForgeError('FORGE_INSTALL_SOURCE_MISSING', `no such archive: ${source}`)
  }
  if (!info.isFile()) {
    throw new ForgeError('FORGE_INSTALL_SOURCE_MISSING', `not a file: ${source}`)
  }

  options.onProgress?.('extract')
  await mkdir(options.skillsRoot, { recursive: true })
  const staging = await mkdtemp(join(options.skillsRoot, `.skill-install-`))
  try {
    await extractArchive(source, staging)
    // A packaged bundle has `<name>/...` as its archive root; a registry archive
    // puts the payload at the root. Accept either, refuse ambiguity.
    const payload = await resolvePayloadRoot(staging)
    const manifestText = await readManifestFile(payload)
    const parsed = parseManifest(manifestText, 'skill.yaml')
    if (parsed.manifest === undefined) {
      const first = parsed.issues[0]
      throw new ForgeError(
        'FORGE_MANIFEST_INVALID',
        first === undefined ? 'manifest is invalid' : `${first.path}: ${first.message}`,
      )
    }
    const manifest = parsed.manifest
    if (manifest.skillDocument !== 'SKILL.md') {
      throw new ForgeError('FORGE_MANIFEST_INVALID', 'installed bundles must use SKILL.md')
    }
    try {
      await stat(join(payload, 'SKILL.md'))
    } catch {
      throw new ForgeError('FORGE_MANIFEST_INVALID', 'archive root must contain SKILL.md')
    }
    if (options.running?.includes(manifest.name) === true) {
      throw new ForgeError(
        'FORGE_SKILL_RUNNING',
        `skill "${manifest.name}" is running; stop it before replacing its bundle`,
      )
    }

    options.onProgress?.('swap')
    const target = join(options.skillsRoot, manifest.name)
    let replaced: number | undefined
    let backup: string | undefined
    const existing = await stat(target).catch(() => undefined)
    if (existing !== undefined) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const previousVersion = await currentVersion(target)
      backup = join(options.skillsRoot, '.backups', manifest.name, `${previousVersion}-${stamp}`)
      await mkdir(dirname(backup), { recursive: true })
      await rename(target, backup)
      replaced = await directorySize(target).catch(() => undefined) ?? existing.size
    }
    try {
      await rename(payload, target)
    } catch (error) {
      if (backup !== undefined) await rename(backup, target).catch(() => undefined)
      throw error
    }
    return {
      name: manifest.name,
      version: manifest.version,
      path: target,
      bytes: info.size,
      ...(replaced === undefined ? {} : { replaced }),
    }
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined)
  }
}

/**
 * Find the directory that actually holds `skill.yaml`.
 *
 * `forge_skill_package` writes `<name>/...` (a clean archive root); registry
 * archives put the payload at the root. A single wrapping directory is accepted,
 * anything more ambiguous is refused rather than guessed.
 */
async function resolvePayloadRoot(extracted: string): Promise<string> {
  const hasManifest = async (dir: string): Promise<boolean> => {
    try {
      await stat(join(dir, 'skill.yaml'))
      return true
    } catch {
      return false
    }
  }
  if (await hasManifest(extracted)) return extracted
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(extracted, { withFileTypes: true })
  const directories = entries.filter(entry => entry.isDirectory())
  if (directories.length === 1 && entries.length === 1) {
    const candidate = join(extracted, directories[0]!.name)
    if (await hasManifest(candidate)) return candidate
  }
  throw new ForgeError(
    'FORGE_MANIFEST_INVALID',
    entries.length === 0
      ? 'archive is empty'
      : 'archive does not contain skill.yaml at its root or in a single top-level directory',
  )
}

/** Best-effort version of an installed bundle, used to name its backup. */
async function currentVersion(dir: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  try {
    const text = await readFile(join(dir, 'skill.yaml'), 'utf8')
    // Only top-level scalars: an indented `version:` belongs to a node lock.
    const match = /^version:[ \t]*(.+)$/m.exec(text)
    if (match !== null) {
      const value = match[1]!.trim().replace(/^['"]|['"]$/g, '')
      if (value.length > 0 && !value.includes('/')) return value
    }
  } catch {
    // fall through
  }
  return 'unknown'
}

/** Recursive byte size, used only for reporting how much a replacement freed. */
async function directorySize(dir: string): Promise<number> {
  const { readdir } = await import('node:fs/promises')
  let total = 0
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    const info = await lstat(absolute)
    total += info.isDirectory() ? await directorySize(absolute) : info.size
  }
  return total
}

interface CachedArchive {
  readonly path: string
  readonly bytes: number
  readonly fromCache: boolean
}

async function fetchArchive(artifact: RegistryArtifact, options: InstallOptions): Promise<CachedArchive> {
  await mkdir(options.cacheRoot, { recursive: true })
  const key = artifact.sha256 ?? createHash('sha256').update(artifact.url).digest('hex')
  const path = join(options.cacheRoot, `${key}.tar.gz`)
  try {
    const info = await stat(path)
    if (artifact.size === undefined || info.size === artifact.size) {
      options.onProgress?.('download', info.size, info.size)
      return { path, bytes: info.size, fromCache: true }
    }
    await rm(path, { force: true })
  } catch {
    // not cached yet
  }

  options.onProgress?.('download', 0, artifact.size)
  const transfer = await downloadFile({
    url: artifact.url,
    dest: path,
    sha256: artifact.sha256,
    size: artifact.size,
    signal: options.signal,
    onProgress: progress => options.onProgress?.('download', progress.downloaded, progress.total ?? artifact.size),
  })
  return { path: transfer.path, bytes: transfer.bytes, fromCache: false }
}

async function readManifestFile(dir: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  try {
    return await readFile(join(dir, 'skill.yaml'), 'utf8')
  } catch {
    throw new ForgeError('FORGE_MANIFEST_INVALID', 'archive does not contain skill.yaml at its root')
  }
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9-]+/gi, '-')
}
