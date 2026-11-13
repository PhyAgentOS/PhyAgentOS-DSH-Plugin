import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { parse as parseYaml } from 'yaml'

import { ForgeCatalog, SkillRuntimeManager } from '../packages/core/lib/index.js'

async function makeSkill(gatewayUrl) {
  const home = await mkdtemp(join(tmpdir(), 'forge-launch-'))
  const dir = join(home, 'skills', 'demo')
  await mkdir(join(dir, 'profiles', 'default'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), '# demo\n')
  await writeFile(join(dir, 'profiles', 'default', 'dataflow.yaml'), 'nodes:\n  - id: probe\n    path: /bin/true\n')
  await writeFile(join(dir, 'skill.yaml'), [
    'manifest_version: 2', 'name: demo', 'version: 0.1.0', 'description: demo',
    `gateway_url: ${gatewayUrl}`, 'profiles:', '  default:', '    dataflow: profiles/default/dataflow.yaml',
    '    required_environment: [PROBE_REQUIRED]', '    environment:', '      PROBE_FIXED: fixed-from-skill', '',
  ].join('\n'))
  return home
}

/** Fake dora: `start` and `run` boot a tiny gateway on $DEMO_PORT and record its pid. */
async function makeDora(bin, log) {
  const script = join(bin, 'dora')
  await writeFile(script, `#!/bin/sh
echo "$@" >> ${log}
case "$1" in
  --version) echo "dora-cli 0.4.1" ;;
  list) exit 0 ;;
  start) node -e 'require("http").createServer((q,s)=>s.end("{\\"ok\\":true,\\"tools\\":[]}")).listen(Number(process.env.DEMO_PORT),"127.0.0.1")' >/dev/null 2>&1 & echo $! > "$DEMO_PID"; exit 0 ;;
  run) node -e 'require("http").createServer((q,s)=>s.end("{\\"ok\\":true,\\"tools\\":[]}")).listen(Number(process.env.DEMO_PORT),"127.0.0.1")' >/dev/null 2>&1 & echo $! > "$DEMO_PID"; sleep 30 ;;
  stop) exit 0 ;;
esac
`)
  await chmod(script, 0o755)
  return script
}

async function freePort() {
  const { createServer } = await import('node:net')
  return new Promise(resolvePort => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolvePort(port))
    })
  })
}

async function setup() {
  const bin = await mkdtemp(join(tmpdir(), 'forge-bin-'))
  const log = join(bin, 'calls.log')
  await writeFile(log, '')
  const port = await freePort()
  process.env['DEMO_PORT'] = String(port)
  process.env['DEMO_PID'] = join(bin, 'gateway.pid')
  const dora = await makeDora(bin, log)
  process.env['PROBE_REQUIRED'] = 'from-host'
  const home = await makeSkill(`http://127.0.0.1:${port}`)
  const catalog = new ForgeCatalog(join(home, 'skills'))
  const manager = new SkillRuntimeManager({
    home, catalog, registry: { node: async () => ({ url: 'https://example.com/x.tgz' }) }, dora, startTimeoutMs: 5000,
  })
  const cleanup = async () => {
    try {
      const pid = Number(await readFile(process.env['DEMO_PID'], 'utf8'))
      process.kill(pid, 'SIGKILL')
    } catch { /* already gone */ }
    delete process.env['PROBE_REQUIRED']
    await rm(home, { recursive: true, force: true })
    await rm(bin, { recursive: true, force: true })
  }
  return { manager, log, cleanup, port, home }
}

test('coordinator launch uses dora start and records launch=start', async () => {
  const { manager, log, cleanup, home } = await setup()
  try {
    process.env['PROBE_REQUIRED'] = 'from-host'
    const started = await manager.start('demo', 'default')
    assert.equal(started.launch, 'start')
    assert.equal(started.pid, undefined)
    assert.equal(started.status, 'healthy')
    const calls = await readFile(log, 'utf8')
    assert.match(calls, /^start /m)
    assert.match(calls, /^list$/m)

    // Deployment env is merged into node-level env of the materialized copy.
    const envRoot = join(home, 'runtime/env/demo/default')
    const [hash] = await readdir(envRoot)
    const dataflow = parseYaml(await readFile(join(envRoot, hash, 'launch/profiles/default/dataflow.yaml'), 'utf8'))
    const nodeEnv = dataflow.nodes[0].env
    assert.equal(nodeEnv.PROBE_FIXED, 'fixed-from-skill')
    assert.equal(nodeEnv.PROBE_REQUIRED, 'from-host')
    assert.equal(nodeEnv.FORGE_FLOW_ID, started.flow)
    assert.match(nodeEnv.FORGE_RUNTIME_BIN, /bin$/)
    delete process.env['PROBE_REQUIRED']

    assert.equal((await manager.stop('demo'))?.status, 'stopped')
  } finally {
    await cleanup()
  }
})

test('run launch spawns a process, records pid, and stop kills it', async () => {
  const { manager, log, cleanup, home } = await setup()
  try {
    const started = await manager.start('demo', 'default', { launch: 'run' })
    assert.equal(started.launch, 'run')
    assert.ok(started.pid)
    assert.equal(started.status, 'healthy')
    assert.match(await readFile(log, 'utf8'), /^run /m)

    const stopped = await manager.stop('demo')
    assert.equal(stopped?.status, 'stopped')
    assert.equal(stopped?.pid, undefined)
    let alive = true
    for (let index = 0; index < 60 && alive; index += 1) {
      try {
        process.kill(started.pid, 0)
        await new Promise(resolveWait => setTimeout(resolveWait, 50))
      } catch {
        alive = false
      }
    }
    assert.equal(alive, false)
  } finally {
    await cleanup()
  }
})
