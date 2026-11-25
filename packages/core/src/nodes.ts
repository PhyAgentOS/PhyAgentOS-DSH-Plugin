import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { extractArchive } from './archive.js'
import { downloadFile } from './download.js'
import { ForgeError } from './errors.js'
import type { ForgeArtifactNode, ForgeManifest } from './manifest.js'
import type { ForgeRegistryClient } from './registry.js'

/** Cache state of one locked node artifact. */
export interface NodeStatus {
  readonly artifactId: string
  readonly state: 'ready' | 'missing' | 'unverified' | 'mismatch' | 'not-executable'
  readonly entrypoint: string
  readonly detail: string
}

/** Transfer hooks shared by install and start. */
export interface NodeHooks {
  readonly signal?: AbortSignal | undefined
  readonly onProgress?: ((artifactId: string, downloaded: number, total: number | undefined) => void) | undefined
}

export interface NodeEnsureResult {
  readonly installed: string[]
  readonly reused: string[]
  readonly bytes: number
}

export interface GcResult {
  readonly removed: string[]
  readonly freedBytes: number
  readonly kept: string[]
}

interface ArtifactMetadata {
  readonly artifactId: string
  readonly sha256?: string
  readonly version?: string
  readonly verifiedAt: string
}

/**
 * Content-addressed cache for locked node artifacts.
 *
 * Executable nodes keep their entrypoint at the artifact root. Directory nodes
 * keep it inside the runtime directory named after the entrypoint.
 */
export class NodeStore {
  constructor(
    readonly root: string,
    private readonly registry: ForgeRegistryClient,
    private readonly cacheRoot: string,
  ) {}

  /** Read-only cache inspection; never downloads. */
  async inspect(lock: ForgeArtifactNode, binary = lock.nodeId): Promise<NodeStatus> {
    const dir = join(this.root, lock.artifactId)
    const entrypoint = nodeEntrypoint(dir, lock)
    if (!(await isExecutable(entrypoint))) {
      return { artifactId: lock.artifactId, entrypoint, state: 'missing', detail: `${binary}: ${dir} is not installed` }
    }
    let metadata: ArtifactMetadata | undefined
    try {
      metadata = JSON.parse(await readFile(join(dir, '.artifact.json'), 'utf8')) as ArtifactMetadata
    } catch {
      metadata = undefined
    }
    if (metadata === undefined) {
      return { artifactId: lock.artifactId, entrypoint, state: 'unverified', detail: `${binary}: present without digest record` }
    }
    if (lock.sha256 !== undefined && metadata.sha256 !== lock.sha256) {
      return {
        artifactId: lock.artifactId,
        entrypoint,
        state: 'mismatch',
        detail: `${binary}: digest ${metadata.sha256 ?? 'unknown'} does not match lock ${lock.sha256}`,
      }
    }
    return { artifactId: lock.artifactId, entrypoint, state: 'ready', detail: `${binary}: verified ${metadata.sha256 ?? 'unpinned'}` }
  }

  /** Ensure every artifact referenced by the manifest is present and verified. */
  async ensureManifest(manifest: ForgeManifest, artifactIds?: readonly string[], hooks: NodeHooks = {}): Promise<NodeEnsureResult> {
    const lockList = Object.values(manifest.artifacts)
      .filter(lock => artifactIds === undefined || artifactIds.includes(lock.artifactId))
      .sort((left, right) => left.artifactId.localeCompare(right.artifactId))
    const installed: string[] = []
    const reused: string[] = []
    let bytes = 0
    for (const lock of lockList) {
      const status = await this.inspect(lock)
      if (status.state === 'ready') {
        reused.push(lock.artifactId)
        continue
      }
      bytes += await this.download(lock, hooks)
      installed.push(lock.artifactId)
    }
    return { installed, reused, bytes }
  }

  /** Measure the cache: one row per installed artifact directory. */
  async summary(): Promise<{ artifacts: Array<{ id: string; bytes: number }>; totalBytes: number }> {
    const artifacts: Array<{ id: string; bytes: number }> = []
    let totalBytes = 0
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch {
      return { artifacts, totalBytes }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const bytes = await directorySize(join(this.root, entry.name))
      artifacts.push({ id: entry.name, bytes })
      totalBytes += bytes
    }
    return { artifacts: artifacts.sort((left, right) => left.id.localeCompare(right.id)), totalBytes }
  }

  /** Remove artifacts no installed skill references; `dryRun` only measures. */
  async gc(referenced: ReadonlySet<string>, dryRun = false): Promise<GcResult> {
    const removed: string[] = []
    const kept: string[] = []
    let freedBytes = 0
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch {
      return { removed, freedBytes, kept }
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (referenced.has(entry.name)) {
        kept.push(entry.name)
        continue
      }
      const path = join(this.root, entry.name)
      freedBytes += await directorySize(path)
      if (!dryRun) await rm(path, { recursive: true, force: true })
      removed.push(entry.name)
    }
    return { removed, freedBytes, kept }
  }

  private async download(lock: ForgeArtifactNode, hooks: NodeHooks): Promise<number> {
    if (lock.platform !== process.platform || lock.arch !== archName()) {
      throw new ForgeError('FORGE_NODE_PLATFORM', `${lock.artifactId} targets ${lock.platform}/${lock.arch}`)
    }
    const directoryNode = lock.artifactType === 'directory_tar_gz'
    if (directoryNode && (lock.entrypoint === '.' || lock.entrypoint === '..' || /[/\\:\0]/.test(lock.entrypoint))) {
      throw new ForgeError('FORGE_NODE_ENTRYPOINT', `${lock.artifactId} requires a single entrypoint name`)
    }
    const artifact = await this.registry.node(lock.artifactId)
    if (lock.sha256 !== undefined && artifact.sha256 !== undefined && artifact.sha256 !== lock.sha256) {
      throw new ForgeError('FORGE_NODE_INTEGRITY', `registry digest for ${lock.artifactId} disagrees with the skill lock`)
    }
    const expected = lock.sha256 ?? artifact.sha256
    await mkdir(this.cacheRoot, { recursive: true })
    const archive = join(this.cacheRoot, `${lock.artifactId}.tar.gz`)
    const transfer = await downloadFile({
      url: artifact.url,
      dest: archive,
      sha256: expected,
      size: artifact.size,
      signal: hooks.signal,
      onProgress: progress => hooks.onProgress?.(lock.artifactId, progress.downloaded, progress.total),
    })

    const target = join(this.root, lock.artifactId)
    await mkdir(this.root, { recursive: true })
    const staging = await mkdtemp(join(this.root, '.staging-'))
    try {
      await extractArchive(archive, staging, { allowInternalLinks: directoryNode })
      if (directoryNode) {
        const entries = await readdir(staging, { withFileTypes: true })
        if (entries.length !== 1 || entries[0]?.name !== lock.entrypoint || !entries[0].isDirectory()) {
          throw new ForgeError('FORGE_NODE_ENTRYPOINT', `${lock.artifactId} must contain one root directory named ${lock.entrypoint}`)
        }
      }
      const entrypoint = nodeEntrypoint(staging, lock)
      if (!(await isExecutable(entrypoint))) {
        throw new ForgeError('FORGE_NODE_ENTRYPOINT', `${lock.artifactId} has no executable ${entrypoint.slice(staging.length + 1)}`)
      }
      const metadata: ArtifactMetadata = {
        artifactId: lock.artifactId,
        ...(expected === undefined ? {} : { sha256: expected }),
        ...(lock.version === undefined ? {} : { version: lock.version }),
        verifiedAt: new Date().toISOString(),
      }
      await writeFile(join(staging, '.artifact.json'), JSON.stringify(metadata, null, 2))
      await rm(target, { recursive: true, force: true })
      await rename(staging, target)
    } finally {
      await rm(staging, { recursive: true, force: true })
    }
    await rm(archive, { force: true })
    return transfer.bytes
  }
}

function nodeEntrypoint(root: string, lock: ForgeArtifactNode): string {
  return lock.artifactType === 'directory_tar_gz'
    ? join(root, lock.entrypoint, lock.entrypoint)
    : join(root, lock.entrypoint)
}

async function directorySize(path: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await directorySize(child)
    else {
      try {
        total += (await stat(child)).size
      } catch {
        // race with removal
      }
    }
  }
  return total
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function archName(): string {
  if (process.arch === 'x64') return 'x86_64'
  if (process.arch === 'arm64') return 'aarch64'
  if (process.arch === 'ia32') return 'x86'
  return process.arch
}
