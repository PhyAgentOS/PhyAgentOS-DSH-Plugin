import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'

import { ForgeCatalog, parseManifest, toolsForProfile } from '../packages/core/lib/index.js'

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

test('catalog lists valid bundles and keeps broken ones as diagnostics', async () => {
  const catalog = new ForgeCatalog(fixtures)
  const { skills, diagnostics } = await catalog.list()
  assert.deepEqual(skills.map(skill => skill.name), ['broken-doc', 'env-probe', 'minimal-grasp'])
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
