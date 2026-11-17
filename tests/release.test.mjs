import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { packages, parseTag, validateManifest, validateExisting, validateDependencies, waitForPublished } from '../scripts/release.mjs'

for (const [id, directory] of Object.entries(packages)) {
  test(`${id} has an independent tag and correctly attributed source`, async () => {
    const manifest = JSON.parse(await readFile(new URL(`../${directory}/package.json`, import.meta.url), 'utf8'))
    const release = parseTag(`${id}/v${manifest.version}`)
    assert.equal(release.directory, directory)
    assert.equal(release.name, manifest.name)
    validateManifest(release, manifest)
    assert.throws(() => validateManifest(release, { ...manifest, version: '9.9.9' }), /Tag must match/)
  })
}

test('rejects generic, unknown, invalid and build-metadata tags', () => {
  for (const tag of ['v0.1.0', 'other/v0.1.0', 'forge-core/v01.2.3', 'forge-core/v1.2.3-01', 'forge-core/v1.2.3+local', '../v1.2.3']) {
    assert.throws(() => parseTag(tag))
  }
  assert.equal(parseTag('forge-cli/v1.2.3-rc.1').version, '1.2.3-rc.1')
})

test('retry accepts only the identical published commit and tarball', () => {
  const release = { name: '@x-era/forge-core', version: '0.1.0', commit: 'abc' }
  const published = { ...release, gitHead: 'abc', dist: { integrity: 'sha512-same' } }
  validateExisting(release, published, 'sha512-same')
  assert.throws(() => validateExisting(release, published, 'sha512-different'), /different source or bytes/)
  assert.throws(() => validateExisting(release, { ...published, gitHead: 'another' }, 'sha512-same'), /different source or bytes/)
})

test('consumer release requires its exact internal dependency to be published first', async () => {
  const manifest = { dependencies: { '@x-era/forge-core': '0.1.0', yaml: '^2.8.1' } }
  const requests = []
  await validateDependencies(manifest, async (name, version) => {
    requests.push([name, version])
    return { name, version }
  })
  assert.deepEqual(requests, [['@x-era/forge-core', '0.1.0']])
  await assert.rejects(validateDependencies(manifest, async () => undefined), /Publish dependency first/)
  await assert.rejects(validateDependencies({ dependencies: { '@x-era/forge-core': 'file:../core' } }), /must be exact/)
})

const pendingRelease = { name: '@x-era/forge-core', version: '0.1.1', commit: 'abc', integrity: 'sha512-same' }
const visibleRelease = { ...pendingRelease, gitHead: 'abc', dist: { integrity: 'sha512-same' } }

test('accepted upload waits through missing metadata before validating the published version', async () => {
  const responses = [undefined, undefined, visibleRelease]
  const sleeps = []
  await waitForPublished(pendingRelease, {
    lookup: async (name, version) => {
      assert.equal(name, pendingRelease.name)
      assert.equal(version, pendingRelease.version)
      return responses.shift()
    },
    now: () => 0,
    sleep: async ms => { sleeps.push(ms) },
  })
  assert.deepEqual(sleeps, [15000, 15000])
  assert.equal(responses.length, 0)
})

test('publication waiting is bounded and reports an accepted but unavailable upload', async () => {
  let time = 0
  let requests = 0
  const sleeps = []
  await assert.rejects(waitForPublished(pendingRelease, {
    lookup: async () => { requests++; return undefined },
    now: () => time,
    timeoutMs: 20000,
    sleep: async ms => { sleeps.push(ms); time += ms },
  }), /Timed out waiting.*npm accepted the upload.*retry the same tag/)
  assert.deepEqual(sleeps, [15000, 5000])
  assert.equal(requests, 3)
})

test('publication waiting preserves registry errors and source or integrity mismatches', async () => {
  const failure = new Error('npm registry lookup failed: 403')
  const noSleep = async () => assert.fail('must not retry this failure')
  await assert.rejects(waitForPublished(pendingRelease, {
    lookup: async () => { throw failure }, sleep: noSleep,
  }), error => error === failure)
  for (const published of [
    { ...visibleRelease, gitHead: 'different' },
    { ...visibleRelease, dist: { integrity: 'sha512-different' } },
  ]) {
    await assert.rejects(waitForPublished(pendingRelease, {
      lookup: async () => published, sleep: noSleep,
    }), /different source or bytes/)
  }
})
