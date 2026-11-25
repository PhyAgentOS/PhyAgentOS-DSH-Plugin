import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as tarCreate } from 'tar'
import { test } from 'node:test'

import { NodeStore } from '../packages/core/lib/index.js'

const arch = { x64: 'x86_64', arm64: 'aarch64', ia32: 'x86' }[process.arch] ?? process.arch

const lock = {
  nodeId: 'demo',
  artifactId: `demo-0.1.0-${process.platform}-${arch}-tar-gz`,
  version: '0.1.0',
  platform: process.platform,
  arch,
  artifactType: 'executable_tar_gz',
  entrypoint: 'demo',
}

test('node store downloads once, verifies, and reuses the cache', async () => {
  const work = await mkdtemp(join(tmpdir(), 'forge-nodes-'))
  const bundle = join(work, 'bundle')
  await mkdir(bundle, { recursive: true })
  await writeFile(join(bundle, 'demo'), '#!/bin/sh\necho demo\n')
  await chmod(join(bundle, 'demo'), 0o755)
  const archive = join(work, 'demo.tar.gz')
  await tarCreate({ file: archive, cwd: bundle, gzip: true }, ['demo'])

  let downloads = 0
  const server = createServer((_request, response) => {
    downloads += 1
    response.end(readFileSync(archive))
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  const { port } = server.address()

  try {
    const registry = {
      node: async () => ({ name: lock.artifactId, url: `http://127.0.0.1:${port}/demo.tar.gz` }),
    }
    const store = new NodeStore(join(work, 'nodes'), registry, join(work, 'cache'))

    const before = await store.inspect(lock)
    assert.equal(before.state, 'missing')

    const first = await store.ensureManifest({ artifacts: { demo: lock } })
    assert.deepEqual(first.installed, [lock.artifactId])
    assert.equal(downloads, 1)

    const after = await store.inspect(lock)
    assert.equal(after.state, 'ready')

    const second = await store.ensureManifest({ artifacts: { demo: lock } })
    assert.deepEqual(second.reused, [lock.artifactId])
    assert.equal(downloads, 1, 'second ensure must not download again')

    const metadata = JSON.parse(await readFile(join(work, 'nodes', lock.artifactId, '.artifact.json'), 'utf8'))
    assert.equal(metadata.artifactId, lock.artifactId)
  } finally {
    server.close()
    await rm(work, { recursive: true, force: true })
  }
})

test('directory nodes keep the nested executable and internal runtime links on install and reuse', async t => {
  const work = await mkdtemp(join(tmpdir(), 'forge-directory-node-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const payload = join(work, 'demo')
  await mkdir(join(payload, '_internal'), { recursive: true })
  await writeFile(join(payload, 'demo'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(payload, '_internal', 'libdemo.so.1'), 'runtime dependency')
  await symlink('libdemo.so.1', join(payload, '_internal', 'libdemo.so'))
  await symlink('../_internal/libdemo.so', join(payload, '_internal', 'libalias.so'))
  const archive = join(work, 'demo.tar.gz')
  await tarCreate({ file: archive, cwd: work, gzip: true }, ['demo'])
  const bytes = await readFile(archive)
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  const server = createServer((_request, response) => response.end(bytes))
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/demo.tar.gz`
  const registry = { node: async () => ({ url, sha256, size: bytes.length }) }
  const store = new NodeStore(join(work, 'nodes'), registry, join(work, 'cache'))
  const directoryLock = { ...lock, artifactType: 'directory_tar_gz', sha256 }
  const manifest = { artifacts: { demo: directoryLock } }

  assert.deepEqual((await store.ensureManifest(manifest)).installed, [lock.artifactId])
  const status = await store.inspect(directoryLock)
  assert.equal(status.state, 'ready')
  const installed = join(store.root, lock.artifactId, 'demo')
  assert.equal(status.entrypoint, join(installed, 'demo'))
  assert.equal(await readlink(join(installed, '_internal', 'libalias.so')), '../_internal/libdemo.so')
  assert.equal(await readFile(join(installed, '_internal', 'libalias.so'), 'utf8'), 'runtime dependency')
  assert.deepEqual((await store.ensureManifest(manifest)).reused, [lock.artifactId])
})
