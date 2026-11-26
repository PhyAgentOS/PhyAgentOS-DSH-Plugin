import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { withLock } = await import('../packages/core/lib/lock.js')

const STALE_MS = 10 * 60_000

async function makeHome() {
  return mkdtemp(join(tmpdir(), 'forge-lock-'))
}

/** Write a lock owned by `pid`, with an mtime `ageMs` in the past. */
async function writeLock(path, pid, ageMs) {
  const record = pid === undefined ? {} : { pid, at: new Date(Date.now() - ageMs).toISOString() }
  await writeFile(path, JSON.stringify(record))
  const seconds = (Date.now() - ageMs) / 1000
  await utimes(path, seconds, seconds)
}

function startLive() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' })
}

async function startDead() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  await new Promise(resolveExit => child.on('exit', resolveExit))
  return child.pid
}

test('a lock held by a live process is not reclaimed by age', async () => {
  const home = await makeHome()
  const path = join(home, 'forge.lock')
  const holder = startLive()
  try {
    // Exactly the regression a longer startup budget exposes: the holder is
    // still running, but the lock looks abandoned by age alone.
    await writeLock(path, holder.pid, STALE_MS + 1_000)
    await assert.rejects(
      withLock(path, async () => 'should not run', { timeoutMs: 300, staleMs: STALE_MS }),
      error => error.code === 'FORGE_BUSY',
    )
    assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, holder.pid, 'the live lock is untouched')
  } finally {
    holder.kill('SIGKILL')
    await rm(home, { recursive: true, force: true })
  }
})

test('a lock held by a dead process is reclaimed even when it is young', async () => {
  const home = await makeHome()
  const path = join(home, 'forge.lock')
  try {
    await writeLock(path, await startDead(), 0)
    const result = await withLock(path, async () => 'ran', { timeoutMs: 300, staleMs: STALE_MS })
    assert.equal(result, 'ran')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an aged lock without a pid still falls back to the age heuristic', async () => {
  const home = await makeHome()
  const path = join(home, 'forge.lock')
  try {
    await writeLock(path, undefined, STALE_MS + 1_000)
    const result = await withLock(path, async () => 'ran', { timeoutMs: 300, staleMs: STALE_MS })
    assert.equal(result, 'ran')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('a fresh lock without a pid is respected', async () => {
  const home = await makeHome()
  const path = join(home, 'forge.lock')
  try {
    await writeLock(path, undefined, 0)
    await assert.rejects(
      withLock(path, async () => 'should not run', { timeoutMs: 300, staleMs: STALE_MS }),
      error => error.code === 'FORGE_BUSY',
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
