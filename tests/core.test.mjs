import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  ForgeCatalog,
  SUPPORTED_FORGE_VERSIONS,
  isForgeGeneration,
  parseManifest,
  toolsForProfile,
  unsupportedForgeVersionDetail,
} from '../packages/core/lib/index.js'

const fixtures = fileURLToPath(new URL('../fixtures/skills', import.meta.url))

test('parses a valid manifest-v2 bundle', async () => {
  const text = await (await import('node:fs/promises')).readFile(join(fixtures, 'minimal-grasp', 'skill.yaml'), 'utf8')
  const { manifest, issues } = parseManifest(text)
  assert.deepEqual(issues, [])
  assert.equal(manifest.name, 'minimal-grasp')
  assert.equal(manifest.skillDocument, 'SKILL.md')
  assert.equal(manifest.gatewayUrl, 'http://127.0.0.1:19002')
  assert.deepEqual(Object.keys(manifest.profiles), ['mujoco-piper'])
  assert.equal(manifest.artifacts.gateway.artifactId, 'gateway-1.0.2-linux-x86_64-tar-gz')
})

test('rejects a broken manifest and reports stable codes', async () => {
  const text = await (await import('node:fs/promises')).readFile(join(fixtures, 'broken-manifest', 'skill.yaml'), 'utf8')
  const { manifest, issues } = parseManifest(text)
  assert.equal(manifest, undefined)
  const paths = issues.map(issue => issue.path)
  assert.ok(paths.includes('manifest_version'))
  assert.ok(paths.includes('version'))
  assert.ok(paths.includes('gateway_url'))
  assert.ok(issues.every(issue => issue.code === 'FORGE_MANIFEST_INVALID'))
})

test('profile required_tools overrides the manifest list instead of appending', async () => {
  const text = `
manifest_version: 2
name: override-check
version: 1.0.0
description: override check
gateway_url: http://127.0.0.1:19002
required_tools: [sim.get_robot_info, sim.reset]
profiles:
  default:
    dataflow: profiles/default/dataflow.yaml
    required_tools: [sim.get_robot_info]
  other:
    dataflow: profiles/other/dataflow.yaml
`
  const { manifest } = parseManifest(text)
  assert.ok(manifest)
  assert.deepEqual(toolsForProfile(manifest, 'default'), ['sim.get_robot_info'])
  assert.deepEqual(toolsForProfile(manifest, 'other'), ['sim.get_robot_info', 'sim.reset'])
})

test('profile startup_timeout_s is parsed, and absent stays undefined', () => {
  const text = `
manifest_version: 2
name: timeout-check
version: 1.0.0
description: timeout check
gateway_url: http://127.0.0.1:19002
profiles:
  heavy:
    dataflow: profiles/heavy/dataflow.yaml
    startup_timeout_s: 900
  legacy:
    dataflow: profiles/legacy/dataflow.yaml
`
  const { manifest, issues } = parseManifest(text)
  assert.deepEqual(issues, [])
  assert.ok(manifest)
  assert.equal(manifest.profiles.heavy.startupTimeoutS, 900)
  assert.equal(manifest.profiles.legacy.startupTimeoutS, undefined)
})

test('profile startup_timeout_s rejects a non-positive value', () => {
  const text = `
manifest_version: 2
name: timeout-invalid
version: 1.0.0
description: timeout invalid
gateway_url: http://127.0.0.1:19002
profiles:
  default:
    dataflow: profiles/default/dataflow.yaml
    startup_timeout_s: 0
`
  const { issues } = parseManifest(text)
  const issue = issues.find(entry => entry.path === 'profiles.default.startup_timeout_s')
  assert.ok(issue)
  assert.equal(issue.code, 'FORGE_MANIFEST_INVALID')
})

test('catalog lists valid bundles and keeps broken ones as diagnostics', async () => {
  const catalog = new ForgeCatalog(fixtures)
  const { skills, diagnostics } = await catalog.list()
  assert.deepEqual(skills.map(skill => skill.name), ['broken-doc', 'env-probe', 'forge2-minimal', 'minimal-grasp'])
  assert.deepEqual(diagnostics.map(diagnostic => diagnostic.name), ['broken-manifest'])
  assert.match(diagnostics[0].message, /manifest_version/)
})

test('inspect reports a missing instruction document', async () => {
  const catalog = new ForgeCatalog(fixtures)
  const inspection = await catalog.inspect('broken-doc')
  assert.ok(inspection)
  const doc = inspection.checks.find(check => check.id === 'skill_document')
  assert.equal(doc?.status, 'fail')
})

test('inspect passes for a complete bundle', async () => {
  const catalog = new ForgeCatalog(fixtures)
  const inspection = await catalog.inspect('minimal-grasp')
  assert.ok(inspection)
  assert.ok(inspection.checks.every(check => check.status !== 'fail'))
})

test('static inspect accepts every generation the runtime implements', async () => {
  const catalog = new ForgeCatalog(fixtures)
  for (const [name, label] of [['minimal-grasp', 'Forge 1'], ['forge2-minimal', 'Forge 2']]) {
    const inspection = await catalog.inspect(name)
    assert.ok(inspection, `${name} is in the catalog`)
    const check = inspection.checks.find(entry => entry.id === 'forge_version')
    assert.equal(check?.status, 'pass', `${name} forge_version pass`)
    assert.match(check?.detail ?? '', new RegExp(label), `${name} detail names ${label}`)
  }
})

test('generation helpers cover exactly the supported set', () => {
  assert.deepEqual([...SUPPORTED_FORGE_VERSIONS], ['1', '2'])
  assert.equal(isForgeGeneration('1'), true)
  assert.equal(isForgeGeneration('2'), true)
  assert.equal(isForgeGeneration('3'), false)
  const detail = unsupportedForgeVersionDetail('3')
  assert.match(detail, /Forge 3/)
  assert.match(detail, /Forge 1 \(dora 0\.4\.1\)/)
  assert.match(detail, /Forge 2 \(dora 1\.x/)
})
