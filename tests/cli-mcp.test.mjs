import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const cli = join(root, 'packages/cli/bin/forge.mjs')
const mcp = join(root, 'packages/mcp/bin/forge-mcp.mjs')

test('cli lists an empty home as JSON', async () => {
  const home = await mkdtemp(join(tmpdir(), 'forge-cli-'))
  try {
    const { stdout } = await execFileAsync(process.execPath, [cli, 'list'], { env: { ...process.env, DSH_FORGE_HOME: home } })
    const value = JSON.parse(stdout)
    assert.equal(value.ok, true)
    assert.deepEqual(value.skills, [])
    assert.equal(value.home, home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('mcp server answers initialize, tools/list and tools/call', async () => {
  const home = await mkdtemp(join(tmpdir(), 'forge-mcp-'))
  const child = execFile(process.execPath, [mcp], { env: { ...process.env, DSH_FORGE_HOME: home } })
  const responses = []
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (line.trim().length > 0) responses.push(JSON.parse(line))
    }
  })
  try {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'forge_skill_list', arguments: {} } })}\n`)
    for (let index = 0; index < 100 && responses.length < 3; index += 1) {
      await new Promise(resolveWait => setTimeout(resolveWait, 50))
    }
    assert.equal(responses.length, 3)
    assert.equal(responses[0].result.serverInfo.name, 'forge-mcp')
    assert.ok(responses[1].result.tools.length >= 20)
    const payload = JSON.parse(responses[2].result.content[0].text)
    assert.deepEqual(payload.skills, [])
  } finally {
    child.kill()
    await rm(home, { recursive: true, force: true })
  }
})
