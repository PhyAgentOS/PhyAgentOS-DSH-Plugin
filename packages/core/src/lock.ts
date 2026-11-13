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

async function isStale(path: string, staleMs: number): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(path, 'utf8')) as { pid?: number }
    if (typeof owner.pid === 'number' && owner.pid !== process.pid && !isAlive(owner.pid)) return true
    const info = await stat(path)
    return Date.now() - info.mtimeMs > staleMs
  } catch {
    // Unreadable or half-written lock: treat as stale.
    return true
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
