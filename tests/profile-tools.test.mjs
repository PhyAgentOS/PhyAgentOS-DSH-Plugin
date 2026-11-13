import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ForgeOperations, ForgeError } from '../packages/core/lib/index.js'

const fixtures = fileURLToPath(new URL('../fixtures/skills', import.meta.url))

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'forge-profile-'))
  await cp(join(fixtures, 'minimal-grasp'), join(home, 'skills', 'minimal-grasp'), { recursive: true })
  return home
}

test('lists, reads and writes profile files with a diff and backup', async () => {
  const home = await makeHome()
  try {
    const operations = new ForgeOperations({ home })
    const tree = await operations.profileTree()
    assert.deepEqual(tree[0].profiles[0].files.map(file => file.path), ['dataflow.yaml'])

    const read = await operations.profileRead('minimal-grasp', 'mujoco-piper', 'dataflow.yaml')
    assert.equal(read.valid, true)
    assert.match(read.content, /nodes:/)

    const written = await operations.profileWrite('minimal-grasp', 'mujoco-piper', 'dataflow.yaml', 'nodes:\n  - id: gateway\n')
    assert.equal(written.changed > 0, true)
    assert.equal(written.restartRequired, true)
    assert.equal(written.diff.length, written.changed)
    assert.ok(written.backup)
    assert.match(await readFile(written.path, 'utf8'), /id: gateway/)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('rejects invalid YAML and path traversal', async () => {
  const home = await makeHome()
  try {
    const operations = new ForgeOperations({ home })
    await assert.rejects(
      operations.profileWrite('minimal-grasp', 'mujoco-piper', 'dataflow.yaml', 'a: [\n'),
      (error) => error instanceof ForgeError && error.code === 'FORGE_FILE_INVALID',
    )
    await assert.rejects(operations.profileRead('minimal-grasp', 'mujoco-piper', '../../skill.yaml'))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
