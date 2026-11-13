import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { downloadFile } from '../packages/core/lib/index.js'

const payload = Buffer.alloc(256 * 1024, 7)
const digest = createHash('sha256').update(payload).digest('hex')

function rangeServer(handler) {
  return createServer((request, response) => handler(request, response, payload))
}

test('downloads, verifies and reports progress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-dl-'))
  const server = rangeServer((request, response, body) => {
    response.writeHead(200, { 'content-length': body.length })
    response.end(body)
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  try {
    const seen = []
    const result = await downloadFile({
      url: `http://127.0.0.1:${server.address().port}/a`,
      dest: join(dir, 'a.bin'),
      sha256: digest,
      size: payload.length,
      onProgress: progress => seen.push(progress.downloaded),
    })
    assert.equal(result.bytes, payload.length)
    assert.equal(seen.at(-1), payload.length)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('resumes a partial file through a Range request', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-dl-'))
  const dest = join(dir, 'b.bin')
  await writeFile(`${dest}.part`, payload.subarray(0, 100 * 1024))
  let ranged = false
  const server = rangeServer((request, response, body) => {
    const header = request.headers.range
    const start = header === undefined ? 0 : Number(header.replace('bytes=', '').replace('-', ''))
    ranged = header !== undefined
    response.writeHead(header === undefined ? 200 : 206, { 'content-length': body.length - start })
    response.end(body.subarray(start))
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  try {
    const result = await downloadFile({
      url: `http://127.0.0.1:${server.address().port}/b`,
      dest,
      sha256: digest,
      size: payload.length,
    })
    assert.equal(ranged, true)
    assert.equal(result.resumed, true)
    assert.equal(createHash('sha256').update(await readFile(dest)).digest('hex'), digest)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects a digest mismatch and removes the file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-dl-'))
  const server = rangeServer((request, response, body) => {
    response.writeHead(200, { 'content-length': body.length })
    response.end(body)
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  try {
    await assert.rejects(downloadFile({
      url: `http://127.0.0.1:${server.address().port}/c`,
      dest: join(dir, 'c.bin'),
      sha256: '0'.repeat(64),
    }), /FORGE_NODE_INTEGRITY/)
    assert.equal(existsSync(join(dir, 'c.bin')), false)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('rejects a transfer larger than the free space before fetching', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-dl-'))
  try {
    await assert.rejects(downloadFile({
      url: 'http://127.0.0.1:1/never',
      dest: join(dir, 'huge.bin'),
      size: 1024 ** 5,
    }), /FORGE_DISK_FULL/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('aborts an idle transfer', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-dl-'))
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-length': 1000 })
    response.write('x') // never finish
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  try {
    await assert.rejects(downloadFile({
      url: `http://127.0.0.1:${server.address().port}/d`,
      dest: join(dir, 'd.bin'),
      idleTimeoutMs: 200,
    }), /FORGE_TIMEOUT/)
  } finally {
    server.close()
    await rm(dir, { recursive: true, force: true })
  }
})
