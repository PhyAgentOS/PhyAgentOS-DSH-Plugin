import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { packages, parseTag, validateManifest, validateExisting, validateDependencies } from '../scripts/release.mjs'

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
