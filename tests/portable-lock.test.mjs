import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { parse as parseYaml } from 'yaml'

import { ForgeCatalog, exportPortableSkill, withLock } from '../packages/core/lib/index.js'

const fixtures = fileURLToPath(new URL('../fixtures/skills', import.meta.url))

test('portable export synthesizes frontmatter and keeps the authored body', async () => {
  const out = await mkdtemp(join(tmpdir(), 'forge-portable-'))
  try {
    const entry = await new ForgeCatalog(fixtures).load('minimal-grasp')
    assert.ok(entry)
    const exported = await exportPortableSkill(entry, out)
    const document = await readFile(join(exported.path, 'SKILL.md'), 'utf8')
    const frontmatter = document.split('---')[1]
    const parsed = parseYaml(frontmatter)
    assert.equal(parsed.name, 'minimal-grasp')
    assert.equal(parsed.description, 'Minimal fixture skill used by the forge plugin tests.')
    assert.deepEqual(parsed.metadata.forge.profiles, ['mujoco-piper'])
    assert.match(document, /forge_tool_call/)
    assert.match(document, /# minimal-grasp/)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
})

test('lock excludes a second holder and reclaims a stale lock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-lock-'))
  try {
    const path = join(dir, 'forge.lock')
    await assert.rejects(
      withLock(path, async () => {
        await withLock(path, async () => undefined, { timeoutMs: 200 })
      }),
      /FORGE_BUSY/,
    )

    await writeFile(path, JSON.stringify({ pid: 999_999 }))
    const value = await withLock(path, async () => 'reclaimed', { timeoutMs: 1000 })
    assert.equal(value, 'reclaimed')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
