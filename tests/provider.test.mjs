import assert from 'node:assert/strict'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { ForgeCatalog } from '../packages/core/lib/index.js'
import { createForgeProvider } from '../packages/skill/lib/provider.js'
import { watchRoots } from '../packages/skill/lib/watch.js'

const fixtures = fileURLToPath(new URL('../fixtures/skills', import.meta.url))

test('provider lists bundles and loads a body without frontmatter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-provider-'))
  try {
    await cp(join(fixtures, 'minimal-grasp'), join(root, 'minimal-grasp'), { recursive: true })
    const provider = createForgeProvider({ catalogs: [new ForgeCatalog(root)] })

    const candidates = await provider.list()
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].name, 'minimal-grasp')
    assert.equal(candidates[0].rank, 450)
    assert.deepEqual(candidates[0].metadata.forge.profiles, ['mujoco-piper'])

    const definition = await provider.get(candidates[0], {})
    assert.ok(definition)
    assert.match(definition.content, /# minimal-grasp/)
    assert.equal(definition.provider, 'forge')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('watcher invalidates on add and remove so the next list is fresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'forge-watch-'))
  try {
    const provider = createForgeProvider({ catalogs: [new ForgeCatalog(root)] })
    let invalidations = 0
    const watcher = watchRoots([root], () => { invalidations += 1 }, 50)

    try {
      assert.equal((await provider.list()).length, 0)

      const second = join(root, 'second-skill')
      await mkdir(join(second, 'profiles', 'default'), { recursive: true })
      await writeFile(join(second, 'skill.yaml'), [
        'manifest_version: 2',
        'name: second-skill',
        'version: 0.2.0',
        'description: second fixture',
        'gateway_url: http://127.0.0.1:19002',
        'profiles:',
        '  default:',
        '    dataflow: profiles/default/dataflow.yaml',
        '',
      ].join('\n'))
      await writeFile(join(second, 'SKILL.md'), '# second-skill\n')

      await waitFor(() => invalidations > 0, 'invalidation after add')
      const afterAdd = await provider.list()
      assert.deepEqual(afterAdd.map(candidate => candidate.name), ['second-skill'])

      await rm(second, { recursive: true, force: true })
      const before = invalidations
      await waitFor(() => invalidations > before, 'invalidation after remove')
      assert.deepEqual(await provider.list(), [])
    } finally {
      watcher.close()
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function waitFor(predicate, label, timeoutMs = 5000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return
    await new Promise(resolveWait => setTimeout(resolveWait, 25))
  }
  assert.fail(`timed out waiting for ${label}`)
}
