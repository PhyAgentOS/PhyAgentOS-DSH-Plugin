import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { JobRunner, NodeStore } from '../packages/core/lib/index.js'

test('job runner records progress, result and survives a restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-jobs-'))
  try {
    const jobs = new JobRunner(join(dir, 'jobs'))
    const record = jobs.start('install', 'demo', async job => {
      job.progress({ phase: 'download', downloadedBytes: 5, totalBytes: 10 })
      await new Promise(resolveWait => setTimeout(resolveWait, 20))
      return { installed: true }
    })
    const current = await jobs.wait(record.id)
    assert.equal(current?.state, 'succeeded')
    assert.deepEqual(current?.result, { installed: true })

    const persisted = JSON.parse(await readFile(join(dir, 'jobs', `${record.id}.json`), 'utf8'))
    assert.equal(persisted.state, 'succeeded')

    const reopened = new JobRunner(join(dir, 'jobs'))
    assert.equal((await reopened.get(record.id))?.state, 'succeeded')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('job runner cancels a running task', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-jobs-'))
  try {
    const jobs = new JobRunner(join(dir, 'jobs'))
    const record = jobs.start('install', 'demo', async job => {
      await new Promise(resolveWait => {
        job.signal.addEventListener('abort', () => resolveWait(undefined), { once: true })
      })
      return {}
    })
    assert.equal(jobs.cancel(record.id), true)
    const current = await jobs.wait(record.id)
    assert.equal(current?.state, 'cancelled')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('node store gc removes only unreferenced artifacts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-gc-'))
  try {
    await mkdir(join(dir, 'nodes', 'keep-me'), { recursive: true })
    await writeFile(join(dir, 'nodes', 'keep-me', 'bin'), 'x')
    await mkdir(join(dir, 'nodes', 'drop-me'), { recursive: true })
    await writeFile(join(dir, 'nodes', 'drop-me', 'bin'), '0123456789')

    const store = new NodeStore(join(dir, 'nodes'), { node: async () => ({ name: 'x', url: 'http://127.0.0.1:1/x' }) }, join(dir, 'cache'))
    const summary = await store.summary()
    assert.equal(summary.artifacts.length, 2)

    const dry = await store.gc(new Set(['keep-me']), true)
    assert.deepEqual(dry.removed, ['drop-me'])
    assert.equal((await store.summary()).artifacts.length, 2)

    const real = await store.gc(new Set(['keep-me']))
    assert.deepEqual(real.removed, ['drop-me'])
    assert.equal(real.freedBytes, 10)
    assert.deepEqual((await store.summary()).artifacts.map(item => item.id), ['keep-me'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
