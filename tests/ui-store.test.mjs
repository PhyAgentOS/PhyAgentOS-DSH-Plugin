import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { DshProfileStore, ForgeCatalog, SkillFileStore, validateConfig } from '../packages/core/lib/index.js'

async function makeProfile() {
  const home = await mkdtemp(join(tmpdir(), 'forge-settings-'))
  const profile = join(home, 'profiles', 'web')
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), '{"name":"dsh-profile-web","dsh":{"profile":{"bundles":[]}}}\n')
  return { home, profile }
}

test('writes the forge row into a profile patch and keeps other rows and comments', async () => {
  const { home, profile } = await makeProfile()
  try {
    await writeFile(join(profile, 'cordis.patch.yml'), [
      '# keep me',
      '- id: llm-pi-ai',
      '  config:',
      '    providers: {}',
      '',
    ].join('\n'))
    const store = new DshProfileStore({ profilesRoot: join(home, 'profiles') })

    const before = await store.read('web')
    assert.equal(before.rowExists, false)

    const result = await store.write('web', { home: '/srv/forge', registry: { url: 'https://registry.example' } })
    assert.ok(result.backup)

    const text = await readFile(join(profile, 'cordis.patch.yml'), 'utf8')
    assert.match(text, /# keep me/)
    assert.match(text, /id: llm-pi-ai/)
    assert.match(text, /id: forge-skill/)
    assert.match(text, /\/srv\/forge/)

    const after = await store.read('web')
    assert.equal(after.rowExists, true)
    assert.equal(after.config.home, '/srv/forge')

    await store.write('web', { home: '/srv/forge2' })
    const second = await store.read('web')
    assert.equal(second.config.home, '/srv/forge2')
    assert.equal((await readFile(join(profile, 'cordis.patch.yml'), 'utf8')).match(/id: forge-skill/g).length, 1)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('lists and restores config backups', async () => {
  const { home, profile } = await makeProfile()
  try {
    await writeFile(join(profile, 'cordis.patch.yml'), '- id: original\n')
    const store = new DshProfileStore({ profilesRoot: join(home, 'profiles') })
    await store.write('web', { home: '/v1' })
    const backups = await store.listBackups('web')
    assert.equal(backups.length, 1)

    const restored = await store.restoreBackup('web', backups[0].file)
    assert.equal(restored.restored, backups[0].file)
    assert.ok(restored.previous)
    assert.match(await readFile(join(profile, 'cordis.patch.yml'), 'utf8'), /id: original/)
    assert.equal((await store.listBackups('web')).length, 2)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('rejects unknown keys and wrong types before writing', () => {
  assert.throws(() => validateConfig({ nope: 1 }), /unknown config key/)
  assert.throws(() => validateConfig({ skills: { watch: 'yes' } }), /skills\.watch/)
  assert.deepEqual(validateConfig({ runtime: { startTimeoutMs: 1000 } }), { runtime: { startTimeoutMs: 1000 } })
})

test('skill file store only exposes profile files and validates YAML', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-files-'))
  try {
    const dir = join(root, 'demo-skill')
    await mkdir(join(dir, 'profiles', 'mujoco'), { recursive: true })
    await writeFile(join(dir, 'skill.yaml'), [
      'manifest_version: 2',
      'name: demo-skill',
      'version: 0.1.0',
      'description: demo',
      'gateway_url: http://127.0.0.1:19002',
      'profiles:',
      '  mujoco:',
      '    dataflow: profiles/mujoco/dataflow.yaml',
      '',
    ].join('\n'))
    await writeFile(join(dir, 'SKILL.md'), '# demo\n')
    await writeFile(join(dir, 'profiles', 'mujoco', 'dataflow.yaml'), 'nodes: []\n')

    const store = new SkillFileStore(new ForgeCatalog(root))
    const tree = await store.tree()
    assert.equal(tree[0].name, 'demo-skill')
    assert.deepEqual(tree[0].profiles[0].files.map(file => file.path), ['dataflow.yaml'])

    assert.equal(await store.read('demo-skill', 'mujoco', 'dataflow.yaml'), 'nodes: []\n')

    const written = await store.write('demo-skill', 'mujoco', 'dataflow.yaml', 'nodes:\n  - id: gateway\n')
    assert.ok(written.backup)
    assert.match(await readFile(join(dir, 'profiles', 'mujoco', 'dataflow.yaml'), 'utf8'), /gateway/)

    await assert.rejects(store.write('demo-skill', 'mujoco', 'dataflow.yaml', 'a: [\n'), /FORGE_FILE_INVALID|YAML/)
    await assert.rejects(store.read('demo-skill', 'mujoco', '../../skill.yaml'))
    await assert.rejects(store.read('demo-skill', 'missing', 'dataflow.yaml'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
