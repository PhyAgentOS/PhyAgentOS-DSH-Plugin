import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as tarCreate } from 'tar'
import { test } from 'node:test'

import { NodeStore } from '../packages/core/lib/index.js'

const lock = {
  nodeId: 'demo',
  artifactId: 'demo-0.1.0-linux-x86_64-tar-gz',
  version: '0.1.0',
  platform: process.platform,
  arch: process.arch === 'x64' ? 'x86_64' : process.arch,
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
