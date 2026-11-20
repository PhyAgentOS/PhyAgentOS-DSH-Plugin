import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const {
  checkEnvironment,
  ForgeOperations,
  forgePaths,
  ModelStore,
  modelsForProfile,
  parseManifest,
  resolveForgeModelsRoot,
  validateConfig,
} = await import('../packages/core/lib/index.js')

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

async function createTempHome() {
  const root = await mkdtemp(join(tmpdir(), 'forge-models-'))
  return { root, home: join(root, 'forge') }
}

async function writeModel(modelsRoot, id, revision, filename, content, receipt = {}) {
  const dir = revision === null ? join(modelsRoot, id) : join(modelsRoot, id, revision)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, filename)
  await writeFile(filePath, content)
  if (receipt !== null) {
    const digest = sha256(content)
    await writeFile(join(dir, 'receipt.json'), JSON.stringify({
      id,
      ...(revision === null ? {} : { revision }),
      filename,
      sha256: digest,
      size: Buffer.byteLength(content),
      ...receipt,
    }, null, 2))
  }
  return { dir, filePath, digest: sha256(content) }
}

async function writeSkill(skillsRoot, name, yamlBody) {
  const dir = join(skillsRoot, name)
  await mkdir(join(dir, 'profiles', 'default'), { recursive: true })
  await writeFile(join(dir, 'SKILL.md'), `# ${name}\n`)
  await writeFile(join(dir, 'profiles', 'default', 'dataflow.yaml'), 'nodes: []\n')
  await writeFile(join(dir, 'skill.yaml'), yamlBody)
  return dir
}

test('resolveForgeModelsRoot respects explicit > DSH_FORGE_MODELS > <home>/models', () => {
  const home = '/tmp/example-forge'
  assert.equal(resolveForgeModelsRoot(home, undefined, {}), join(home, 'models'))
  assert.equal(
    resolveForgeModelsRoot(home, undefined, { DSH_FORGE_MODELS: '/data/shared-models' }),
    '/data/shared-models',
  )
  assert.equal(
    resolveForgeModelsRoot(home, 'custom-models', { DSH_FORGE_MODELS: '/data/shared-models' }),
    join(home, 'custom-models'),
  )
  assert.equal(forgePaths(home, '/mnt/models').models, '/mnt/models')
})

test('parseManifest parses required_models and merges profile overrides', () => {
  const digestA = sha256('sam3-v1')
  const digestB = sha256('sam3-v2')
  const parsed = parseManifest(`
manifest_version: 2
forge_version: "2"
name: grasp-demo
version: 0.1.0
description: Demo skill using SAM3
gateway_url: http://127.0.0.1:19991
required_models:
  - id: sam3
    revision: v1
    filename: sam3.pt
    sha256: ${digestA}
    env: SAM3_CHECKPOINT_PATH
  - id: depth-anything
    optional: true
profiles:
  default:
    dataflow: profiles/default/dataflow.yaml
  upgraded:
    dataflow: profiles/default/dataflow.yaml
    required_models:
      - id: sam3
        revision: v2
        filename: sam3.pt
        sha256: ${digestB}
        env: SAM3_CHECKPOINT_PATH
`)
  assert.equal(parsed.issues.length, 0)
  assert.ok(parsed.manifest)
  assert.equal(modelsForProfile(parsed.manifest, 'default').length, 2)
  const upgraded = modelsForProfile(parsed.manifest, 'upgraded')
  assert.equal(upgraded.length, 2)
  assert.equal(upgraded.find(item => item.id === 'sam3')?.revision, 'v2')
  assert.equal(upgraded.find(item => item.id === 'sam3')?.sha256, digestB)
})

test('parseManifest rejects unsafe required_models fields', () => {
  const parsed = parseManifest(`
manifest_version: 2
name: bad-model-skill
version: 0.1.0
description: Invalid model declaration
gateway_url: http://127.0.0.1:19992
required_models:
  - id: ../escape
    filename: ../secret.pt
    sha256: not-a-sha
    env: 123BAD
profiles:
  default:
    dataflow: profiles/default/dataflow.yaml
`)
  assert.equal(parsed.manifest, undefined)
  assert.ok(parsed.issues.length >= 1)
})

test('ModelStore scans canonical & flat models, ignores reserved dirs, and supports search/info/verify', async () => {
  const { home } = await createTempHome()
  const modelsRoot = join(home, 'models')
  await mkdir(join(modelsRoot, 'cache'), { recursive: true })
  await writeFile(join(modelsRoot, 'cache', 'partial.part'), 'tmp')

  const sam = await writeModel(modelsRoot, 'sam3', 'pinned_mirror', 'sam3.pt', 'sam3-bytes-v1', {
    source: 'squarefk/sam3-mirror',
    description: 'SAM3 segmentation weights',
    tags: ['vision', 'segmentation'],
    installedAt: '2026-11-06T11:21:00.000Z',
  })
  await writeModel(modelsRoot, 'dinov2', null, 'dinov2_vitl14.safetensors', 'dino-bytes', null)
  // Malformed receipt should produce a diagnostic without crashing list/search.
  await mkdir(join(modelsRoot, 'broken', 'v1'), { recursive: true })
  await writeFile(join(modelsRoot, 'broken', 'v1', 'model.onnx'), 'onnx')
  await writeFile(join(modelsRoot, 'broken', 'v1', 'receipt.json'), '{not-json')

  const store = new ModelStore(modelsRoot)
  const refs = new Map([['sam3', ['vlm-grasp-autoloop-fx2']]])

  const all = await store.list(refs)
  assert.equal(all.exists, true)
  assert.equal(all.count, 3)
  assert.equal(all.diagnostics.length, 1)
  assert.equal(all.diagnostics[0]?.code, 'FORGE_MODEL_RECEIPT_INVALID')

  const byQuery = await store.search({ query: 'segmentation grasp' }, refs)
  assert.equal(byQuery.count, 1)
  assert.equal(byQuery.models[0]?.id, 'sam3')
  assert.equal(byQuery.models[0]?.primaryFile, sam.filePath)
  assert.deepEqual(byQuery.models[0]?.referencedBy, ['vlm-grasp-autoloop-fx2'])

  const byTag = await store.search({ tag: 'VISION' }, refs)
  assert.equal(byTag.count, 1)
  assert.equal(byTag.models[0]?.id, 'sam3')

  const bySkill = await store.search({ skill: 'vlm-grasp-autoloop-fx2' }, refs)
  assert.equal(bySkill.count, 1)
  assert.equal(bySkill.models[0]?.id, 'sam3')

  const flatInfo = await store.info('dinov2')
  assert.equal(flatInfo?.model.revision, 'default')
  assert.equal(flatInfo?.model.filename, 'dinov2_vitl14.safetensors')

  const okVerify = await store.verify('sam3', 'pinned_mirror')
  assert.equal(okVerify.ok, true)
  assert.equal(okVerify.status, 'verified')
  assert.equal(okVerify.actualSha256, sam.digest)

  const unverified = await store.verify('dinov2')
  assert.equal(unverified.ok, true)
  assert.equal(unverified.status, 'unverified')

  // Corrupt the sam3 file and verify mismatch is detected.
  await writeFile(sam.filePath, 'corrupted-bytes')
  const badVerify = await store.verify('sam3', 'pinned_mirror')
  assert.equal(badVerify.ok, false)
  assert.equal(badVerify.status, 'mismatch')
})

test('ForgeOperations searches models with skill references and preflight checks required_models', async () => {
  const { home } = await createTempHome()
  const modelsRoot = join(home, 'models')
  const skillsRoot = join(home, 'skills')
  const doraBinDir = join(home, 'support', 'bin')
  await mkdir(doraBinDir, { recursive: true })
  const fakeDora1 = join(doraBinDir, 'dora1')
  await writeFile(fakeDora1, '#!/bin/sh\necho "dora-cli 1.0.1"\n', { mode: 0o755 })

  const expectedDigest = sha256('sam3-real-weights')
  await writeSkill(skillsRoot, 'vision-grasp', `
manifest_version: 2
forge_version: "2"
name: vision-grasp
version: 0.2.0
description: Vision grasp skill requiring SAM3
gateway_url: http://127.0.0.1:19993
required_models:
  - id: sam3
    revision: pinned_mirror
    filename: sam3.pt
    sha256: ${expectedDigest}
    env: SAM3_CHECKPOINT_PATH
  - id: optional-depth
    optional: true
profiles:
  default:
    dataflow: profiles/default/dataflow.yaml
    required_environment:
      - SAM3_CHECKPOINT_PATH
`)

  const ops = new ForgeOperations({ home, dora1: fakeDora1 })

  // Before installing sam3: preflight fails on required model and missing env.
  const entry = await ops.catalog.load('vision-grasp')
  assert.ok(entry)
  const before = await ops.runtime.preflight(entry, 'default')
  assert.equal(before.ok, false)
  assert.equal(before.checks.find(check => check.id === 'model.sam3')?.status, 'fail')
  assert.equal(before.checks.find(check => check.id === 'model.optional-depth')?.status, 'warn')

  // After placing sam3 in <home>/models/sam3/pinned_mirror/: preflight passes & resolves SAM3_CHECKPOINT_PATH.
  const sam = await writeModel(modelsRoot, 'sam3', 'pinned_mirror', 'sam3.pt', 'sam3-real-weights', {
    tags: ['segmentation'],
  })
  const after = await ops.runtime.preflight(entry, 'default')
  assert.equal(after.ok, true)
  assert.equal(after.checks.find(check => check.id === 'model.sam3')?.status, 'pass')
  assert.equal(after.checks.find(check => check.id === 'environment')?.status, 'pass')
  assert.equal(after.modelEnv?.['SAM3_CHECKPOINT_PATH'], sam.filePath)

  // Operations modelSearch & modelInfo pick up the referencing skill.
  const search = await ops.modelSearch({ skill: 'vision-grasp' })
  assert.equal(search.count, 1)
  assert.equal(search.models[0]?.id, 'sam3')
  assert.deepEqual(search.models[0]?.referencedBy, ['vision-grasp'])

  const info = await ops.modelInfo('sam3')
  assert.equal(info.model.primaryFile, sam.filePath)
  assert.deepEqual(info.revisions, ['pinned_mirror'])

  const inspected = await ops.inspect('vision-grasp')
  assert.equal(Array.isArray(inspected['requiredModels']), true)
  assert.equal(inspected['requiredModels'].length, 2)
})

test('validateConfig accepts models.root/mirror and checkEnvironment reports models dir & FORGE_MODELS_DIR', async () => {
  const valid = validateConfig({ models: { root: '~/.dsh/forge/models', mirror: 'https://mirror.example.com' } })
  assert.equal(valid.models?.root, '~/.dsh/forge/models')
  assert.equal(valid.models?.mirror, 'https://mirror.example.com')
  assert.throws(() => validateConfig({ models: { unknownKey: true } }), /unknown key models\.unknownKey/)

  const { home } = await createTempHome()
  const doraBinDir = join(home, 'support', 'bin')
  await mkdir(doraBinDir, { recursive: true })
  const dora = join(doraBinDir, 'dora')
  const dora1 = join(doraBinDir, 'dora1')
  await writeFile(dora, '#!/bin/sh\necho "dora-cli 0.4.1"\n', { mode: 0o755 })
  await writeFile(dora1, '#!/bin/sh\necho "dora-cli 1.0.1"\n', { mode: 0o755 })
  await writeModel(join(home, 'models'), 'sam3', 'v1', 'sam3.pt', 'weights', { tags: ['sam3'] })

  const report = await checkEnvironment({ home, dora, dora1, offline: true, writeReport: false })
  assert.equal(report.ok, true)
  const modelsCheck = report.checks.find(check => check.id === 'models')
  assert.equal(modelsCheck?.status, 'pass')
  assert.match(modelsCheck?.detail ?? '', /1 model\(s\)/)
  assert.ok(report.runtime.isolation.injected.includes('FORGE_MODELS_DIR'))
})

test('CLI supports forge models, forge model and forge model-verify', async () => {
  const { home } = await createTempHome()
  await writeModel(join(home, 'models'), 'sam3', 'v1', 'sam3.pt', 'cli-weights', { tags: ['vision'] })
  const cli = resolve('packages/cli/bin/forge.mjs')
  const env = { ...process.env, DSH_FORGE_HOME: home }

  const listOut = JSON.parse((await execFileAsync(process.execPath, [cli, 'models', 'sam3', '--tag', 'vision'], { env })).stdout)
  assert.equal(listOut.ok, true)
  assert.equal(listOut.count, 1)
  assert.equal(listOut.models[0].id, 'sam3')

  const infoOut = JSON.parse((await execFileAsync(process.execPath, [cli, 'model', 'sam3'], { env })).stdout)
  assert.equal(infoOut.ok, true)
  assert.equal(infoOut.model.revision, 'v1')

  const verifyOut = JSON.parse((await execFileAsync(process.execPath, [cli, 'model-verify', 'sam3'], { env })).stdout)
  assert.equal(verifyOut.ok, true)
  assert.equal(verifyOut.status, 'verified')
})
