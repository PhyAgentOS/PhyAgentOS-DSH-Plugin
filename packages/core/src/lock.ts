import { open, readFile, rm, stat } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

import { ForgeError } from './errors.js'

export interface LockOptions {
  readonly timeoutMs?: number
  /** A lock file older than this is considered abandoned. */
  readonly staleMs?: number
}

/**
 * Cross-process mutex for one forge home.
 *
 * The DSH host and the CLI may run at the same time; mutating operations take
 * this lock so `state.json` and the skill tree cannot be written concurrently.
 */
export async function withLock<T>(path: string, task: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 60_000
  const staleMs = options.staleMs ?? 10 * 60_000
  const deadline = Date.now() + timeoutMs
  await mkdir(dirname(path), { recursive: true })

  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      } finally {
        await handle.close()
      }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await isStale(path, staleMs)) {
        await rm(path, { force: true })
        continue
      }
      if (Date.now() > deadline) {
        throw new ForgeError('FORGE_BUSY', `another forge process holds ${path}`)
      }
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }

  try {
    return await task()
  } finally {
    await rm(path, { force: true })
  }
}

/**
 * A lock is stale once its holder is gone. Age alone must never reclaim it:
 * `start` holds this lock for the whole startup, and a profile may legitimately
 * declare a `startup_timeout_s` longer than `staleMs`, so an age-based reclaim
 * would let a second writer in while the first one is still running.
 *
 * The age heuristic only remains as a fallback for locks that carry no readable
 * pid, where liveness cannot be checked. A recycled pid can then keep a dead
 * lock alive until `timeoutMs` expires, which fails closed (`FORGE_BUSY`)
 * instead of silently breaking mutual exclusion.
 */
async function isStale(path: string, staleMs: number): Promise<boolean> {
  let owner: { pid?: number }
  let ageMs: number
  try {
    owner = JSON.parse(await readFile(path, 'utf8')) as { pid?: number }
    ageMs = Date.now() - (await stat(path)).mtimeMs
  } catch {
    // Unreadable or half-written lock: treat as stale.
    return true
  }
  if (typeof owner.pid === 'number') {
    if (owner.pid === process.pid) return false
    return !isAlive(owner.pid)
  }
  return ageMs > staleMs
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
