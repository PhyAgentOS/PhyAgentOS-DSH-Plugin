import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { SkillRuntimeManager } = await import('../packages/core/lib/runtime.js')

function entry(forgeVersion) {
  return {
    name: `demo-fv${forgeVersion}`,
    dir: '/tmp/forge-demo',
    manifest: {
      name: `demo-fv${forgeVersion}`,
      version: '0.1.0',
      forgeVersion,
      description: 'demo',
      skillDocument: 'SKILL.md',
      gatewayUrl: 'http://127.0.0.1:19999',
      requiredTools: [],
      profiles: { p: { id: 'p', dataflow: 'profiles/p/dataflow.yaml', requiredBinaries: [], requiredAssets: [], requiredEnvironment: [], environment: {} } },
      artifacts: {},
    },
  }
}

function manager(options) {
  return new SkillRuntimeManager({
    home: '/tmp/forge-runtime-dora-test',
    catalog: { load: async (name) => entry(name.endsWith('2') ? '2' : '1') },
    registry: {},
    ...options,
  })
}

test('forge 1 bundle preflight reports the dora 0.4.1 CLI', async () => {
  const checks = await manager({ dora: '/bin/true', dora1: '/bin/echo' }).preflight(entry('1'), 'p')
  const version = checks.checks.find((check) => check.id === 'forge_version')
  const dora = checks.checks.find((check) => check.id === 'dora')
  assert.equal(version?.status, 'pass')
  assert.match(version?.detail ?? '', /Forge 1 \(dora 0\.4\.1\) via \/bin\/true/)
  assert.match(dora?.detail ?? '', /\/bin\/true/)
})

test('forge 2 bundle preflight uses dora1 and no longer fails on the generation', async () => {
  const checks = await manager({ dora: '/bin/true', dora1: '/bin/echo' }).preflight(entry('2'), 'p')
  const version = checks.checks.find((check) => check.id === 'forge_version')
  const dora = checks.checks.find((check) => check.id === 'dora')
  assert.equal(version?.status, 'pass', 'forge 2 must be accepted by the runtime')
  assert.match(version?.detail ?? '', /Forge 2 \(dora 1\.x, forge-tool 2\.x\) via \/bin\/echo/)
  assert.match(dora?.detail ?? '', /\/bin\/echo/)
})

test('a bundle of an unknown generation is rejected', async () => {
  const checks = await manager({ dora: '/bin/true', dora1: '/bin/echo' }).preflight(entry('3'), 'p')
  assert.equal(checks.checks.find((check) => check.id === 'forge_version')?.status, 'fail')
})

// --- start-level wiring: the profile budget must reach waitForGateway ---------
//
// The gateway here is served by a fake `dora` executable, not by the test
// process: `preflight` refuses a gateway URL whose port is already bound, which
// mirrors reality where the dataflow brings the gateway up.

const GLOBAL_BUDGET_MS = 250
const PROFILE_BUDGET_S = 2
const GATEWAY_READY_AFTER_MS = 700

const FAKE_DORA = `#!/usr/bin/env node
import { createServer } from 'node:http'

const args = process.argv.slice(2)
if (args[0] === '--version') {
  process.stdout.write('dora-rs 0.4.1 (test double)\\n')
  process.exit(0)
}
if (args[0] !== 'run') process.exit(0)

const port = Number(process.env.TEST_GATEWAY_PORT)
const delay = Number(process.env.TEST_READY_DELAY_MS ?? '0')
const started = Date.now()
createServer((request, response) => {
  if (request.url !== '/tools') {
    response.writeHead(404)
    response.end()
    return
  }
  if (Date.now() - started >= delay) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('[]')
    return
  }
  response.writeHead(503)
  response.end('starting')
}).listen(port, '127.0.0.1')
setInterval(() => {}, 1000)
`

async function freePort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise(resolve => server.close(resolve))
  return address.port
}

async function makeSkillDir() {
  const dir = await mkdtemp(join(tmpdir(), 'forge-start-skill-'))
  await mkdir(join(dir, 'profiles', 'p'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), '# demo\n')
  await writeFile(join(dir, 'profiles', 'p', 'dataflow.yaml'), 'nodes:\n  - id: gateway\n    path: gateway\n')
  return dir
}

function startEntry(dir, gatewayUrl, port, startupTimeoutS) {
  const profile = {
    id: 'p',
    dataflow: 'profiles/p/dataflow.yaml',
    requiredBinaries: [],
    requiredAssets: [],
    requiredEnvironment: [],
    environment: {
      TEST_GATEWAY_PORT: String(port),
      TEST_READY_DELAY_MS: String(GATEWAY_READY_AFTER_MS),
    },
    ...(startupTimeoutS === undefined ? {} : { startupTimeoutS }),
  }
  return {
    name: 'demo-start',
    dir,
    manifest: {
      name: 'demo-start',
      version: '0.1.0',
      forgeVersion: '1',
      description: 'demo',
      skillDocument: 'SKILL.md',
      gatewayUrl,
      requiredTools: [],
      profiles: { p: profile },
      artifacts: {},
    },
  }
}

async function withStartHarness(startupTimeoutS, body) {
  const dir = await makeSkillDir()
  const home = await mkdtemp(join(tmpdir(), 'forge-start-home-'))
  const port = await freePort()
  const dora = join(home, 'fake-dora.mjs')
  await writeFile(dora, FAKE_DORA, { mode: 0o755 })
  const manager = new SkillRuntimeManager({
    home,
    catalog: { load: async () => startEntry(dir, `http://127.0.0.1:${port}`, port, startupTimeoutS) },
    registry: {},
    dora,
    pollIntervalMs: 50,
    startTimeoutMs: GLOBAL_BUDGET_MS,
  })
  try {
    await body(manager)
  } finally {
    await manager.stop('demo-start').catch(() => undefined)
    await rm(home, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
}

test('start waits out a profile startup_timeout_s past a shorter global budget', async () => {
  // The gateway answers /tools only after GATEWAY_READY_AFTER_MS: longer than
  // startTimeoutMs, well inside the profile's 2 s. Without the pass-through this
  // start fails; with it, it must reach healthy.
  await withStartHarness(PROFILE_BUDGET_S, async manager => {
    const state = await manager.start('demo-start', 'p', { launch: 'run' })
    assert.equal(state.status, 'healthy')
  })
})

test('start falls back to the global budget when the profile declares none', async () => {
  await withStartHarness(undefined, async manager => {
    await assert.rejects(
      manager.start('demo-start', 'p', { launch: 'run' }),
      error => error.code === 'FORGE_GATEWAY_UNREACHABLE',
    )
  })
})
