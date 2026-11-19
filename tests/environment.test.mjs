import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { checkEnvironment, EnvironmentCode } = await import('../packages/core/lib/environment.js')

/** Write a fake CLI that answers a version string, like `dora --version` would. */
async function fakeCli(root, name, output) {
  const dir = join(root, 'bin')
  await mkdir(dir, { recursive: true })
  const file = join(dir, name)
  await writeFile(file, `#!/bin/sh\necho "${output}"\n`, { mode: 0o755 })
  return file
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'forge-env-'))
  return { root, home: join(root, 'forge') }
}

function checkOf(report, id) {
  const found = report.checks.find(check => check.id === id)
  assert.ok(found !== undefined, `missing check "${id}" in ${report.checks.map(check => check.id).join(', ')}`)
  return found
}

test('reports a healthy machine and writes a JSON report under runtime/reports', async () => {
  const { home } = await workspace()
  const dora = await fakeCli(home, 'dora', 'dora-cli 0.4.1')
  const dora1 = await fakeCli(home, 'dora1', 'dora-cli 1.0.1')

  const report = await checkEnvironment({ home, dora, dora1, offline: true, skills: [] })

  assert.equal(report.ok, true)
  assert.equal(checkOf(report, 'platform').status, 'pass')
  assert.equal(checkOf(report, 'node').status, 'pass')
  assert.equal(checkOf(report, 'dora').status, 'pass')
  assert.match(checkOf(report, 'dora').detail, /dora-cli 0\.4\.1/)
  assert.equal(checkOf(report, 'dora1').status, 'pass')
  assert.equal(checkOf(report, 'home').status, 'pass')
  assert.equal(checkOf(report, 'disk').status, 'pass')
  assert.equal(checkOf(report, 'registry').detail, 'probe skipped (offline)')
  assert.equal(checkOf(report, 'ports').code, EnvironmentCode.noSkills)

  assert.ok(report.path !== undefined)
  const written = JSON.parse(await readFile(report.path, 'utf8'))
  assert.equal(written.ok, true)
  assert.equal(written.home, home)
  const mode = (await stat(report.path)).mode & 0o777
  assert.equal(mode, 0o600)
})

test('fails when the Forge 1 dora CLI is missing, with a hint to configure it', async () => {
  const { home } = await workspace()
  const dora1 = await fakeCli(home, 'dora1', 'dora-cli 1.0.1')

  const report = await checkEnvironment({
    home,
    dora: join(home, 'bin', 'missing-dora'),
    dora1,
    offline: true,
    writeReport: false,
  })

  assert.equal(report.ok, false)
  const dora = checkOf(report, 'dora')
  assert.equal(dora.status, 'fail')
  assert.equal(dora.code, EnvironmentCode.doraMissing)
  assert.match(dora.hint, /runtime\.dora/)
  assert.equal(report.summary.fail >= 1, true)
})

test('fails when dora1 is outside the Forge 2 range', async () => {
  const { home } = await workspace()
  const dora = await fakeCli(home, 'dora', 'dora-cli 0.4.1')
  const dora1 = await fakeCli(home, 'dora1', 'dora-cli 2.0.0')

  const report = await checkEnvironment({ home, dora, dora1, offline: true, writeReport: false })

  assert.equal(report.ok, false)
  assert.equal(checkOf(report, 'dora1').code, EnvironmentCode.dora1Version)
})

test('warns, without failing, on a dora generation drift', async () => {
  const { home } = await workspace()
  const dora = await fakeCli(home, 'dora', 'dora-cli 0.5.2')
  const dora1 = await fakeCli(home, 'dora1', 'dora-cli 1.0.1')

  const report = await checkEnvironment({ home, dora, dora1, offline: true, writeReport: false })

  assert.equal(checkOf(report, 'dora').status, 'warn')
  assert.equal(checkOf(report, 'dora').code, EnvironmentCode.doraVersion)
  assert.equal(report.ok, true)
})

test('fails when the data root is not writable', async () => {
  const { root } = await workspace()
  const blocker = join(root, 'not-a-directory')
  await writeFile(blocker, 'x')
  const dora = await fakeCli(root, 'dora', 'dora-cli 0.4.1')
  const dora1 = await fakeCli(root, 'dora1', 'dora-cli 1.0.1')

  const report = await checkEnvironment({
    home: blocker,
    dora,
    dora1,
    offline: true,
    writeReport: false,
  })

  assert.equal(report.ok, false)
  const home = checkOf(report, 'home')
  assert.equal(home.status, 'fail')
  assert.equal(home.code, EnvironmentCode.homeUnwritable)
  assert.equal(report.checks.some(check => check.id === 'disk'), false)
})

test('detects a busy gateway port declared by an installed skill', async () => {
  const { home } = await workspace()
  const dora = await fakeCli(home, 'dora', 'dora-cli 0.4.1')
  const dora1 = await fakeCli(home, 'dora1', 'dora-cli 1.0.1')

  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const busy = `http://127.0.0.1:${address.port}`
  try {
    const report = await checkEnvironment({
      home,
      dora,
      dora1,
      offline: true,
      writeReport: false,
      skills: [{ name: 'demo', gatewayUrl: busy }],
    })
    const port = checkOf(report, `port.127.0.0.1:${address.port}`)
    assert.equal(port.status, 'warn')
    assert.equal(port.code, EnvironmentCode.portBusy)
    assert.match(port.detail, /already in use/)
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('keeps an unreachable registry a warning so offline installs still pass', async () => {
  const { home } = await workspace()
  const dora = await fakeCli(home, 'dora', 'dora-cli 0.4.1')
  const dora1 = await fakeCli(home, 'dora1', 'dora-cli 1.0.1')

  const report = await checkEnvironment({
    home,
    dora,
    dora1,
    writeReport: false,
    registryUrl: 'https://registry.invalid',
    fetch: async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    },
  })

  const registry = checkOf(report, 'registry')
  assert.equal(registry.status, 'warn')
  assert.equal(registry.code, EnvironmentCode.registryUnreachable)
  assert.equal(report.ok, true)
})

/** Create `<home>/runtime/env/<skill>/<profile>/<hash>` and return it. */
async function envDir(home, skill, profile, hash) {
  const dir = join(home, 'runtime', 'env', skill, profile, hash)
  await mkdir(dir, { recursive: true })
  return dir
}

async function runtimeState(home, skills) {
  const runtime = join(home, 'runtime')
  await mkdir(runtime, { recursive: true })
  await writeFile(join(runtime, 'state.json'), JSON.stringify({ skills }, null, 2))
}

test('records the isolated runtime context and flags orphan env dirs', async () => {
  const { home } = await workspace()
  const dora = await fakeCli(home, 'dora', 'dora-cli 0.4.1')
  const dora1 = await fakeCli(home, 'dora1', 'dora-cli 1.0.1')

  const kept = await envDir(home, 'demo', 'p', 'aaa111')
  await writeFile(join(kept, 'runtime-lock.json'), JSON.stringify({
    skill: 'demo',
    version: '0.1.0',
    profile: 'p',
    binaries: {},
    artifacts: { gateway: 'gateway-1.0.2-linux-x86_64-tar-gz' },
  }))
  const orphan = await envDir(home, 'demo', 'p', 'bbb222')
  await runtimeState(home, {
    demo: {
      skill: 'demo',
      profile: 'p',
      flow: 'forge-demo-p-1',
      envDir: kept,
      gatewayUrl: 'http://127.0.0.1:19101',
      startedAt: '2026-11-19T00:00:00.000Z',
      version: '0.1.0',
      status: 'stopped',
      launch: 'run',
      dora: '/bin/dora1',
      forgeVersion: '2',
    },
  })

  const report = await checkEnvironment({ home, dora, dora1, offline: true, writeReport: false, skills: [] })

  assert.equal(report.runtime.stateExists, true)
  assert.equal(report.runtime.envDirs, 2)
  assert.equal(report.runtime.instances.length, 1)
  const instance = report.runtime.instances[0]
  assert.equal(instance.skill, 'demo')
  assert.equal(instance.launch, 'run')
  assert.equal(instance.envDirExists, true)
  assert.equal(instance.lock.version, '0.1.0')
  assert.equal(instance.lock.artifacts, 1)
  assert.deepEqual(report.runtime.orphans, [orphan])
  assert.equal(checkOf(report, 'runtime.state').status, 'pass')
  assert.equal(checkOf(report, 'runtime.env').status, 'pass')
  assert.equal(checkOf(report, 'runtime.orphans').code, EnvironmentCode.envStale)
  assert.match(report.runtime.isolation.envDirTemplate, /<skill>/)
  assert.ok(report.runtime.isolation.injected.includes('FORGE_RUNTIME_BIN'))
  assert.match(report.runtime.isolation.launch.run, /dora run/)
})

test('flags a recorded runtime whose env dir disappeared', async () => {
  const { home } = await workspace()
  const dora = await fakeCli(home, 'dora', 'dora-cli 0.4.1')
  const dora1 = await fakeCli(home, 'dora1', 'dora-cli 1.0.1')
  const gone = join(home, 'runtime', 'env', 'demo', 'p', 'gone')
  await runtimeState(home, {
    demo: { skill: 'demo', profile: 'p', flow: 'forge-demo-p-2', envDir: gone, status: 'stopped' },
  })

  const report = await checkEnvironment({ home, dora, dora1, offline: true, writeReport: false })

  assert.equal(report.runtime.instances[0].envDirExists, false)
  const env = checkOf(report, 'runtime.env')
  assert.equal(env.status, 'warn')
  assert.equal(env.code, EnvironmentCode.envMissing)
  assert.match(env.detail, /demo\/p/)
})

test('warns on an unreadable runtime state file instead of failing', async () => {
  const { home } = await workspace()
  const dora = await fakeCli(home, 'dora', 'dora-cli 0.4.1')
  const dora1 = await fakeCli(home, 'dora1', 'dora-cli 1.0.1')
  await mkdir(join(home, 'runtime'), { recursive: true })
  await writeFile(join(home, 'runtime', 'state.json'), '{not json')

  const report = await checkEnvironment({ home, dora, dora1, offline: true, writeReport: false })

  const state = checkOf(report, 'runtime.state')
  assert.equal(state.status, 'warn')
  assert.equal(state.code, EnvironmentCode.runtimeStateBroken)
  assert.equal(report.ok, true)
})
