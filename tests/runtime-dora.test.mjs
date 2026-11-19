import assert from 'node:assert/strict'
import test from 'node:test'

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
