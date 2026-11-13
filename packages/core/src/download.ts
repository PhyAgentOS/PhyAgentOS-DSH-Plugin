import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, stat, statfs } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { ForgeError } from './errors.js'

/** Progress of one artifact transfer. */
export interface DownloadProgress {
  readonly downloaded: number
  readonly total?: number
}

export interface DownloadOptions {
  readonly url: string
  /** Final path; the transfer happens in `<dest>.part` and is renamed on success. */
  readonly dest: string
  readonly sha256?: string | undefined
  readonly size?: number | undefined
  readonly signal?: AbortSignal | undefined
  /** Abort when no bytes arrive for this long; a GB download is idle-timed, not wall-timed. */
  readonly idleTimeoutMs?: number
  readonly onProgress?: ((progress: DownloadProgress) => void) | undefined
}

export interface DownloadResult {
  readonly path: string
  readonly bytes: number
  readonly sha256: string
  readonly resumed: boolean
}

/**
 * Stream an artifact to disk, resuming a partial `.part` when the server allows it.
 *
 * The digest is computed by streaming the finished file, so a resumed transfer
 * is verified exactly like a fresh one.
 */
export async function downloadFile(options: DownloadOptions): Promise<DownloadResult> {
  await mkdir(dirname(options.dest), { recursive: true })
  const part = `${options.dest}.part`
  const idleTimeoutMs = options.idleTimeoutMs ?? 120_000

  let offset = 0
  try {
    offset = (await stat(part)).size
  } catch {
    offset = 0
  }

  if (options.size !== undefined) await ensureSpace(dirname(options.dest), Math.max(options.size - offset, 0))

  const controller = new AbortController()
  const abort = (reason: unknown): void => {
    controller.abort(reason instanceof Error ? reason : new Error(String(reason)))
  }
  const onOuterAbort = (): void => abort(options.signal?.reason ?? new ForgeError('FORGE_CANCELLED', 'download cancelled'))
  options.signal?.addEventListener('abort', onOuterAbort, { once: true })

  let idleTimer: NodeJS.Timeout | undefined
  const armIdle = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => abort(new ForgeError('FORGE_TIMEOUT', `no data for ${idleTimeoutMs} ms`)), idleTimeoutMs)
    idleTimer.unref?.()
  }

  let resumed = offset > 0
  try {
    armIdle()
    const headers: Record<string, string> = {}
    if (offset > 0) headers['range'] = `bytes=${offset}-`
    let response: Response
    try {
      response = await fetch(options.url, { headers, signal: controller.signal })
    } catch (error) {
      throw new ForgeError('FORGE_REGISTRY_UNAVAILABLE', `download failed: ${(error as Error).message}`)
    }
    if (response.status === 416 && offset > 0) {
      // The server considers the partial file complete; verify it below.
      resumed = true
    } else if (response.status === 206 && offset > 0) {
      resumed = true
    } else if (response.ok) {
      if (offset > 0) {
        resumed = false
        offset = 0
        await rm(part, { force: true })
      }
    } else {
      throw new ForgeError('FORGE_REGISTRY_UNAVAILABLE', `download failed: HTTP ${response.status}`)
    }

    if (response.body !== null && !(response.status === 416 && offset > 0)) {
      const source = Readable.fromWeb(response.body as never)
      let downloaded = offset
      source.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        armIdle()
        options.onProgress?.({ downloaded, total: options.size })
      })
      await pipeline(source, createWriteStream(part, { flags: offset > 0 ? 'a' : 'w' }))
      if (idleTimer !== undefined) clearTimeout(idleTimer)
    }
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    if (existsSync(part)) await rename(part, options.dest)
  } catch (error) {
    if (error instanceof ForgeError) throw error
    throw new ForgeError('FORGE_DOWNLOAD_FAILED', (error as Error).message)
  } finally {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    options.signal?.removeEventListener('abort', onOuterAbort)
  }

  const info = await stat(options.dest)
  if (options.size !== undefined && info.size !== options.size) {
    await rm(options.dest, { force: true })
    throw new ForgeError('FORGE_NODE_INTEGRITY', `size mismatch: expected ${options.size}, got ${info.size}`)
  }
  options.onProgress?.({ downloaded: info.size, total: options.size ?? info.size })

  const digest = await hashFile(options.dest)
  if (options.sha256 !== undefined && digest !== options.sha256) {
    await rm(options.dest, { force: true })
    throw new ForgeError('FORGE_NODE_INTEGRITY', `sha256 mismatch: expected ${options.sha256}, got ${digest}`)
  }
  return { path: options.dest, bytes: info.size, sha256: digest, resumed }
}

async function ensureSpace(dir: string, needed: number): Promise<void> {
  try {
    const info = await statfs(dir)
    const available = Number(info.bavail) * Number(info.bsize)
    if (available < needed) {
      throw new ForgeError('FORGE_DISK_FULL', `need ${needed} bytes in ${dir}, only ${available} available`)
    }
  } catch (error) {
    if (error instanceof ForgeError) throw error
    // statfs is best-effort; an unknown filesystem must not block the transfer.
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(path)
  for await (const chunk of stream) hash.update(chunk as Buffer)
  return hash.digest('hex')
}
