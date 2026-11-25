import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { create as tarCreate } from 'tar'

import { EventLog, extractArchive } from '../packages/core/lib/index.js'

test('rejects an archive containing a symlink entry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-archive-'))
  try {
    await writeFile(join(dir, 'ok.txt'), 'ok')
    await symlink('/etc/passwd', join(dir, 'link'))
    const archive = join(dir, 'evil.tar.gz')
    await tarCreate({ file: archive, cwd: dir, gzip: true, follow: false }, ['ok.txt', 'link'])

    const out = join(dir, 'out')
    await mkdir(out)
    await assert.rejects(extractArchive(archive, out), /FORGE_ARCHIVE_UNSAFE/)
    await assert.rejects(extractArchive(archive, out, { allowInternalLinks: true }), /FORGE_ARCHIVE_UNSAFE/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('extracts a safe archive', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-archive-'))
  try {
    await writeFile(join(dir, 'ok.txt'), 'ok')
    const archive = join(dir, 'ok.tar.gz')
    await tarCreate({ file: archive, cwd: dir, gzip: true }, ['ok.txt'])
    const out = join(dir, 'out')
    await mkdir(out)
    await extractArchive(archive, out)
    assert.equal(await readFile(join(out, 'ok.txt'), 'utf8'), 'ok')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('directory archives reject a dangling runtime link', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-archive-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await symlink('missing.so', join(dir, 'library.so'))
  const archive = join(dir, 'node.tar.gz')
  await tarCreate({ file: archive, cwd: dir, gzip: true, follow: false }, ['library.so'])
  const out = join(dir, 'out')
  await mkdir(out)
  await assert.rejects(extractArchive(archive, out, { allowInternalLinks: true }), /FORGE_ARCHIVE_UNSAFE/)
})

test('event log appends JSONL and can be disabled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-events-'))
  try {
    const path = join(dir, 'events.jsonl')
    const log = new EventLog(path)
    await log.append('install.start', { name: 'demo' })
    await log.append('install.finish', { name: 'demo', bytes: 3 })
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(lines.map(line => line.event), ['install.start', 'install.finish'])
    assert.equal(lines[0].name, 'demo')

    const off = new EventLog(join(dir, 'off.jsonl'), false)
    await off.append('ignored')
    await assert.rejects(readFile(join(dir, 'off.jsonl')), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
