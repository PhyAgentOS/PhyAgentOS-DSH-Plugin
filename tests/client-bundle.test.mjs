import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const bundlePath = fileURLToPath(new URL('../packages/skill/lib/client.js', import.meta.url))

test('client bundle registers a DSH module factory and a plugins.item entry', async () => {
  const code = await readFile(bundlePath, 'utf8')
  let registered
  const window = { __ModuleLoader__: { load: entry => { registered = entry } } }
  globalThis.document = {
    createElement: () => ({ dataset: {}, textContent: '', remove: () => undefined }),
    head: { append: () => undefined },
  }
  // eslint-disable-next-line no-new-func
  const run = new Function('window', code)
  run(window)

  assert.equal(registered.id, '@xera/dsh-forge-skill')

  const react = {
    useState: () => [undefined, () => undefined],
    useEffect: () => undefined,
    createElement: () => null,
  }
  const requireStub = id => {
    if (id === 'react') return react
    if (id === 'react/jsx-runtime') return { jsx: () => null, jsxs: () => null, Fragment: 'fragment' }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      const stub = () => null
      return { Button: stub, Input: stub, Switch: stub }
    }
    throw new Error(`unexpected external: ${id}`)
  }
  const exports = registered.factory(requireStub)
  assert.equal(typeof exports.apply, 'function')

  const seen = []
  const ctx = {
    effect: fn => fn(),
    slots: {
      inject: (name, produce) => { seen.push(`inject:${name}`); return produce() },
      register: (definition) => { seen.push(`register:${definition.id}`); return () => undefined },
    },
  }
  exports.apply(ctx)
  assert.deepEqual(seen, ['inject:plugins.item', 'register:forge-config'])
})
