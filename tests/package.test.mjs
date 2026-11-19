import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, symlink, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

const { packageSkill } = await import('../packages/core/lib/package.js')

async function bundle({ name = 'demo-skill', version = '0.1.0', extra = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'forge-pkg-'))
  const dir = join(root, name)
  await mkdir(join(dir, 'profiles', 'p'), { recursive: true })
  await writeFile(join(dir, 'skill.yaml'), `name: ${name}\nversion: ${version}\n`)
  await writeFile(join(dir, 'SKILL.md'), '# demo\n')
  await writeFile(join(dir, 'profiles', 'p', 'dataflow.yaml'), 'nodes: []\n')
  for (const [path, content] of Object.entries(extra)) {
    await mkdir(join(dir, path, '..'), { recursive: true })
    await writeFile(join(dir, path), content)
  }
  return { root, dir }
}

test('packages a bundle and reports the digest a lock would record', async () => {
  const { root, dir } = await bundle()
  const result = await packageSkill({ bundleDir: dir, outputDir: join(root, 'dist') })

  assert.equal(result.ok, true)
  assert.equal(result.name, 'demo-skill')
  assert.equal(result.version, '0.1.0')
  assert.match(result.sha256, /^[0-9a-f]{64}$/)
  assert.ok(result.bytes > 0)
  const sidecar = await readFile(`${result.archivePath}.sha256`, 'utf8')
  assert.match(sidecar, new RegExp(`^${result.sha256}  demo-skill-0.1.0.tar.gz`))
})

test('is deterministic: identical input yields an identical digest', async () => {
  const first = await bundle()
  const second = await bundle()
  const a = await packageSkill({ bundleDir: first.dir, outputDir: join(first.root, 'dist') })
  const b = await packageSkill({ bundleDir: second.dir, outputDir: join(second.root, 'dist') })
  assert.equal(a.sha256, b.sha256)
  assert.equal(a.bytes, b.bytes)
})

test('excludes caches and venv trees by default and ships a manifest', async () => {
  const { root, dir } = await bundle({
    extra: {
      '__pycache__/x.pyc': 'junk',
      'nodes/__pycache__/y.pyc': 'junk',
      '.git/config': 'junk',
      'support/venv/bin/python': 'junk',
      'keep/me.txt': 'keep',
    },
  })
  const result = await packageSkill({ bundleDir: dir, outputDir: join(root, 'dist') })
  assert.equal(result.excludedVenv, true)

  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const { stdout } = await run('tar', ['tzf', result.archivePath])
  const entries = stdout.trim().split('\n')

  assert.ok(entries.some(entry => entry.endsWith('demo-skill/keep/me.txt')))
  assert.ok(entries.some(entry => entry.endsWith('demo-skill/archive-manifest.json')))
  assert.ok(!entries.some(entry => entry.includes('__pycache__')))
  assert.ok(!entries.some(entry => entry.includes('.git')))
  assert.ok(!entries.some(entry => entry.includes('support/venv')))
})

test('refuses symlinks, a mismatched directory name and an existing archive', async () => {
  const { root, dir } = await bundle()
  await symlink('/etc/hostname', join(dir, 'link'))
  await assert.rejects(
    packageSkill({ bundleDir: dir, outputDir: join(root, 'dist') }),
    /symlinks are not allowed/,
  )

  // Directory name must match the manifest name; rename it to break that.
  const renamed = await bundle({ name: 'other-name' })
  const { rename } = await import('node:fs/promises')
  const moved = join(renamed.root, 'wrong-dir')
  await rename(renamed.dir, moved)
  await assert.rejects(
    packageSkill({ bundleDir: moved, outputDir: join(renamed.root, 'dist') }),
    /must be named "other-name"/,
  )

  const ok = await bundle()
  await packageSkill({ bundleDir: ok.dir, outputDir: join(ok.root, 'dist') })
  await assert.rejects(
    packageSkill({ bundleDir: ok.dir, outputDir: join(ok.root, 'dist') }),
    /already exists/,
  )
  await packageSkill({ bundleDir: ok.dir, outputDir: join(ok.root, 'dist'), force: true })
})
