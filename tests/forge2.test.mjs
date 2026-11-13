import assert from 'node:assert/strict'
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ForgeCatalog, SkillRuntimeManager } from '../packages/core/lib/index.js'

const fixtures = fileURLToPath(new URL('../fixtures/skills', import.meta.url))

test('forge 2 skills select the dora1 binary during preflight', async () => {
  const home = await mkdtemp(join(tmpdir(), 'forge-v2-'))
  const bin = await mkdtemp(join(tmpdir(), 'forge-bin-'))
  try {
    await cp(join(fixtures, 'minimal-grasp'), join(home, 'skills', 'minimal-grasp'), { recursive: true })
    const manifestPath = join(home, 'skills', 'minimal-grasp', 'skill.yaml')
    const manifest = await readFile(manifestPath, 'utf8')
    await writeFile(manifestPath, `forge_version: "2"\n${manifest}`)

    const dora = join(bin, 'dora')
    const dora1 = join(bin, 'dora1')
    await writeFile(dora, '#!/bin/sh\necho "dora-cli 0.4.1"\n')
    await writeFile(dora1, '#!/bin/sh\necho "dora-cli 1.0.1"\n')
    await chmod(dora, 0o755)
    await chmod(dora1, 0o755)

    const catalog = new ForgeCatalog(join(home, 'skills'))
    const manager = new SkillRuntimeManager({
      home,
      catalog,
      registry: { node: async () => ({ url: 'https://example.com/x.tar.gz' }) },
      dora,
      dora1,
    })
    const entry = await catalog.load('minimal-grasp')
    assert.equal(entry?.manifest.forgeVersion, '2')

    const preflight = await manager.preflight(entry, 'mujoco-piper')
    const forge = preflight.checks.find(check => check.id === 'forge_version')
    const doraCheck = preflight.checks.find(check => check.id === 'dora')
    assert.equal(forge?.status, 'pass')
    assert.match(String(forge?.detail), /Forge 2/)
    assert.equal(doraCheck?.status, 'pass')
    assert.match(String(doraCheck?.detail), /1\.0\.1/)
    assert.match(String(doraCheck?.detail), /dora1/)
  } finally {
    await rm(home, { recursive: true, force: true })
    await rm(bin, { recursive: true, force: true })
  }
})
