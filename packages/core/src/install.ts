import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

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
