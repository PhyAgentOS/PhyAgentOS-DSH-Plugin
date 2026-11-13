import assert from 'node:assert/strict'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ForgeOperations, ForgeRegistryClient, validateBundle } from '../packages/core/lib/index.js'

const fixtures = fileURLToPath(new URL('../fixtures/skills', import.meta.url))

test('validates a bundle directory before install', async () => {
  const good = await validateBundle(join(fixtures, 'minimal-grasp'))
  assert.equal(good.ok, true)
  assert.equal(good.name, 'minimal-grasp')
  assert.equal(good.summary.profiles, 1)

  const broken = await validateBundle(join(fixtures, 'broken-doc'))
  assert.equal(broken.ok, false)
  assert.ok(broken.issues.some(issue => issue.code === 'FORGE_SKILL_DOC_MISSING'))
})

test('lists and reads bundle documentation', async () => {
  const home = await mkdtemp(join(tmpdir(), 'forge-docs-'))
  try {
    await cp(join(fixtures, 'minimal-grasp'), join(home, 'skills', 'minimal-grasp'), { recursive: true })
    const operations = new ForgeOperations({ home })
    const docs = await operations.skillDocs('minimal-grasp')
    assert.ok(docs.files.some(file => file.path === 'SKILL.md'))
    assert.ok(docs.files.some(file => file.path === 'skill.yaml'))
    const content = await operations.readSkillDoc('minimal-grasp', 'SKILL.md')
    assert.match(content.content, /minimal-grasp/)
    await assert.rejects(operations.readSkillDoc('minimal-grasp', '../secret.txt'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('skill versions are listed and pinned resolution uses ?version', async () => {
  const seen = []
  const server = createServer((request, response) => {
    seen.push(request.url)
    response.setHeader('content-type', 'application/json')
    if (request.url === '/v1/skills/demo/versions') {
      response.end(JSON.stringify({
        name: 'demo',
        current_version: '0.2.0',
        items: [
          { version: '0.2.0', sha256: 'a'.repeat(64), state: 'published' },
          { version: '0.1.0', sha256: 'b'.repeat(64), state: 'published' },
        ],
      }))
      return
    }
    const version = new URL(request.url, 'http://x').searchParams.get('version') ?? 'current'
    response.end(JSON.stringify({ name: 'demo', version, download_url: 'https://example.com/demo.tgz', sha256: 'c'.repeat(64), size: 10 }))
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  try {
    const { ForgeRegistryClient } = await import('../packages/core/lib/index.js')
    const client = new ForgeRegistryClient({ baseUrl: `http://127.0.0.1:${server.address().port}` })
    const versions = await client.skillVersions('demo')
    assert.equal(versions.currentVersion, '0.2.0')
    assert.deepEqual(versions.versions.map(item => item.version), ['0.2.0', '0.1.0'])

    const pinned = await client.skill('demo', '0.1.0')
    assert.equal(pinned.version, '0.1.0')
    assert.ok(seen.includes('/v1/skills/demo?version=0.1.0'))
  } finally {
    server.close()
  }
})

test('repository catalog resolves repos by node, name and endpoint', async () => {
  const { findRepository, searchRepositories } = await import('../packages/core/lib/index.js')
  assert.equal(findRepository('mujoco_sim')?.id, 'operator-simulator-mujoco')
  assert.equal(findRepository('adapter-forge-gateway')?.role, 'gateway')
  assert.equal(findRepository('sim.get_robot_info'), undefined)

  const gateway = findRepository('gateway')
  assert.equal(gateway?.id, 'adapter-forge-gateway')
  assert.ok(gateway?.keyPaths.includes('src/forge_gateway/controllers/tool_controller.py'))

  const providers = searchRepositories({ query: 'set_opening' })
  assert.deepEqual(providers.map(entry => entry.id), ['operator-gripper-action-policy'])
  assert.ok(searchRepositories({ category: 'adapter' }).length >= 10)
})

test('registry source pinning is parsed and source files are cached', async () => {
  const { ForgeOperations } = await import('../packages/core/lib/index.js')
  const home = await mkdtemp(join(tmpdir(), 'forge-source-'))
  const calls = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return { ok: true, status: 200, text: async () => '# pinned readme\n' }
  }
  try {
    const operations = new ForgeOperations({
      home,
      registry: {
        baseUrl: 'https://registry.example',
        search: async () => [],
        skill: async () => ({ url: 'https://x/y' }),
        node: async () => ({
          name: 'gateway',
          url: 'https://x/gateway.tar.gz',
          version: '1.0.2',
          sourceStatus: 'pinned',
          forgeVersion: 1,
          source: {
            repositoryUrl: 'https://github.com/PhyAgentOS/adapter-forge-gateway',
            ref: 'v1.0.2',
            refType: 'tag',
            commitSha: 'b5d9c591fe60d8115a412d877bfb0efd98fbd091',
            path: '.',
            rawBaseUrl: 'https://raw.githubusercontent.com/PhyAgentOS/adapter-forge-gateway/b5d9c591fe60d8115a412d877bfb0efd98fbd091/',
          },
        }),
      },
    })

    const first = await operations.nodeSource('gateway-1.0.2-linux-x86_64-tar-gz')
    assert.equal(first.cached, false)
    assert.equal(first.content, '# pinned readme\n')
    assert.match(String(first.url), /b5d9c591.*README\.md$/)

    const second = await operations.nodeSource('gateway-1.0.2-linux-x86_64-tar-gz')
    assert.equal(second.cached, true)
    assert.equal(calls.length, 1, 'cache avoids a second fetch')

    await assert.rejects(operations.nodeSource('gateway-1.0.2-linux-x86_64-tar-gz', '../etc/passwd'))
  } finally {
    globalThis.fetch = originalFetch
    await rm(home, { recursive: true, force: true })
  }
})

test('registry client keeps node provenance', async () => {
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({
      artifact_id: 'gateway-1.0.2-linux-x86_64-tar-gz',
      display_name: 'gateway',
      node_type: 'adapter',
      github_url: 'https://github.com/PhyAgentOS/adapter-forge-gateway',
      source_status: 'pinned',
      forge_version: 1,
      source: {
        repository_url: 'https://github.com/PhyAgentOS/adapter-forge-gateway',
        ref: 'v1.0.2',
        ref_type: 'tag',
        commit_sha: 'b5d9c591fe60d8115a412d877bfb0efd98fbd091',
        path: '.',
        raw_base_url: 'https://raw.githubusercontent.com/PhyAgentOS/adapter-forge-gateway/b5d9c591fe60d8115a412d877bfb0efd98fbd091/',
        browse_url: 'https://github.com/PhyAgentOS/adapter-forge-gateway/tree/b5d9c591fe60d8115a412d877bfb0efd98fbd091',
        archive_url: 'https://github.com/PhyAgentOS/adapter-forge-gateway/archive/b5d9c591fe60d8115a412d877bfb0efd98fbd091.tar.gz',
      },
      download_url: 'https://example.com/gateway.tar.gz',
      sha256: 'a'.repeat(64),
      size: 123,
      version: '1.0.2',
    }))
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  try {
    const client = new ForgeRegistryClient({ baseUrl: `http://127.0.0.1:${server.address().port}` })
    const artifact = await client.node('gateway-1.0.2-linux-x86_64-tar-gz')
    assert.equal(artifact.sourceUrl, 'https://github.com/PhyAgentOS/adapter-forge-gateway')
    assert.equal(artifact.nodeType, 'adapter')
    assert.equal(artifact.sourceStatus, 'pinned')
    assert.equal(artifact.forgeVersion, 1)
    assert.equal(artifact.source?.ref, 'v1.0.2')
    assert.equal(artifact.source?.commitSha, 'b5d9c591fe60d8115a412d877bfb0efd98fbd091')
  } finally {
    server.close()
  }
})
