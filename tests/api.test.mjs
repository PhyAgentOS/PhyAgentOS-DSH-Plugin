import assert from 'node:assert/strict'
import { test } from 'node:test'

import { handleApi } from '../packages/skill/lib/ui/api.js'

const deps = {
  currentProfile: 'web',
  profiles: {
    listProfiles: async () => ['web'],
    read: async profile => ({ profile, path: '/tmp/p.yml', rowExists: true, config: { home: '/x' }, raw: '' }),
    write: async (profile, config) => {
      if (config.wrong !== undefined) { const error = new Error('unknown config key "wrong"'); error.code = 'FORGE_CONFIG_INVALID'; throw error }
      return { path: `/tmp/${profile}.yml`, backup: '/tmp/p.yml.bak-1' }
    },
    listBackups: async () => [{ file: 'cordis.patch.yml.bak-20260101', at: '2026-01-01T00:00:00Z', size: 10 }],
    restoreBackup: async (profile, file) => ({ path: `/tmp/${profile}.yml`, restored: file, previous: '/tmp/p.yml.bak-2' }),
  },
  files: {
    tree: async () => [],
    read: async () => 'nodes: []',
    write: async () => ({ path: '/tmp/dataflow.yaml', backup: '/tmp/b' }),
  },
}

const url = path => new URL(`http://127.0.0.1${path}`)
const body = value => async () => value

test('serves config, backups and restore over the shared handler', async () => {
  const read = await handleApi('GET', url('/forge/api/config?profile=web'), deps, body({}))
  assert.equal(read.status, 200)
  assert.equal(read.body.config.home, '/x')

  const backups = await handleApi('GET', url('/forge/api/backups?profile=web'), deps, body({}))
  assert.equal(backups.body.backups.length, 1)

  const restored = await handleApi('POST', url('/forge/api/restore-backup'), deps, body({ profile: 'web', backup: 'cordis.patch.yml.bak-20260101' }))
  assert.equal(restored.status, 200)
  assert.equal(restored.body.restored, 'cordis.patch.yml.bak-20260101')

  const invalid = await handleApi('PUT', url('/forge/api/config'), deps, body({ profile: 'web', config: { wrong: 1 } }))
  assert.equal(invalid.status, 400)
  assert.match(invalid.body.error, /unknown config key/)

  const missing = await handleApi('POST', url('/forge/api/restore-backup'), deps, body({}))
  assert.equal(missing.status, 400)
})
