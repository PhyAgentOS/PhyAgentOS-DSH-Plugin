#!/usr/bin/env node
/** Release one package from an exact <package>/v<version> Git tag. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import semver from 'semver'

export const packages = {
  'forge-core': 'packages/core',
  'dsh-forge-skill': 'packages/skill',
  'forge-cli': 'packages/cli',
  'forge-mcp': 'packages/mcp',
  'dsh-forge': 'bundle',
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const registry = 'https://registry.npmjs.org'

export function parseTag(tag) {
  const match = /^([^/]+)\/v(.+)$/.exec(tag ?? '')
  if (!match || !Object.hasOwn(packages, match[1]) || semver.valid(match[2]) !== match[2]) {
    throw new Error('Expected <package>/v<semver>, e.g. forge-core/v0.1.0')
  }
  if (semver.parse(match[2]).build.length) throw new Error('Build metadata is not supported in release tags')
  return { id: match[1], name: `@x-era/${match[1]}`, version: match[2], directory: packages[match[1]] }
}

export function validateManifest(release, manifest) {
  if (manifest.name !== release.name || manifest.version !== release.version || manifest.private) {
    throw new Error(`Tag must match the publishable manifest: ${release.name}@${release.version}`)
  }
  if (manifest.repository?.url !== 'git+https://github.com/PhyAgentOS/dsh-PhyAgentOS.git') {
    throw new Error('Missing or incorrect public repository metadata')
  }
}

export function validateExisting(release, existing, integrity) {
  if (existing.name !== release.name || existing.version !== release.version
      || existing.gitHead !== release.commit || existing.dist?.integrity !== integrity) {
    throw new Error(`${release.name}@${release.version} already exists with different source or bytes; bump its version`)
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.status}): ${result.stderr ?? ''}`)
  return result.stdout?.trim()
}

async function check(tag) {
  const release = parseTag(tag)
  release.commit = run('git', ['rev-parse', 'HEAD'])
  if (run('git', ['rev-parse', `${tag}^{commit}`]) !== release.commit) {
    throw new Error('Check out the exact release tag before packing or publishing')
  }
  if (run('git', ['status', '--porcelain', '--untracked-files=normal'])) {
    throw new Error('Release requires a clean working tree, including untracked source files')
  }
  run('git', ['merge-base', '--is-ancestor', release.commit, 'origin/main'])
  validateManifest(release, JSON.parse(await readFile(join(root, release.directory, 'package.json'), 'utf8')))
  return release
}

async function pack(tag) {
  const release = await check(tag)
  run(process.execPath, ['scripts/prepare-publish.mjs'], { stdio: 'inherit' })
  run(process.execPath, ['scripts/verify-release.mjs'], { stdio: 'inherit' })
  const directory = join(root, 'dist/publish', release.name)
  const path = join(directory, 'package.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  manifest.gitHead = release.commit
  await writeFile(path, JSON.stringify(manifest, null, 2) + '\n')
  const destination = join(root, 'dist/tarballs')
  await mkdir(destination, { recursive: true })
  const [result] = JSON.parse(run('npm', ['pack', directory, '--json', '--ignore-scripts', '--pack-destination', destination]))
  release.tarball = join(destination, result.filename)
  release.integrity = 'sha512-' + createHash('sha512').update(await readFile(release.tarball)).digest('base64')
  return release
}

async function metadata(name, version) {
  const response = await fetch(`${registry}/${encodeURIComponent(name)}/${encodeURIComponent(version)}`, {
    headers: { 'Cache-Control': 'no-cache' },
    signal: AbortSignal.timeout(30000),
  })
  if (response.status === 404) return undefined
  if (!response.ok) throw new Error(`npm registry lookup failed: ${response.status} for ${name}@${version}`)
  return response.json()
}

export async function validateDependencies(manifest, lookup = metadata) {
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (!name.startsWith('@x-era/')) continue
    if (semver.valid(version) !== version) throw new Error(`Internal release dependency must be exact: ${name}@${version}`)
    if (!await lookup(name, version)) throw new Error(`Publish dependency first: ${name}@${version}`)
  }
}

export async function waitForPublished(release, {
  lookup = metadata, sleep = delay, now = Date.now, timeoutMs = 15 * 60 * 1000,
} = {}) {
  const deadline = now() + timeoutMs
  while (true) {
    const published = await lookup(release.name, release.version)
    if (published) {
      validateExisting(release, published, release.integrity)
      return
    }
    const remaining = deadline - now()
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for ${release.name}@${release.version} after npm accepted the upload. Check npm status and account email; retry the same tag once the version is public.`)
    }
    console.log(`npm is processing ${release.name}@${release.version}; checking again in ${Math.min(15, Math.ceil(remaining / 1000))}s`)
    await sleep(Math.min(15000, remaining))
  }
}

async function publish(tag) {
  const release = await pack(tag)
  const existing = await metadata(release.name, release.version)
  if (existing) {
    validateExisting(release, existing, release.integrity)
    console.log(`Already published with matching tag and bytes: ${release.name}@${release.version}`)
    return release
  }
  const manifest = JSON.parse(await readFile(join(root, 'dist/publish', release.name, 'package.json'), 'utf8'))
  await validateDependencies(manifest)
  const channel = semver.prerelease(release.version) ? 'next' : 'latest'
  const latest = channel === 'latest' ? await metadata(release.name, 'latest') : undefined
  if (latest && semver.gt(latest.version, release.version)) {
    throw new Error(`Refusing to move latest backwards from ${latest.version} to ${release.version}`)
  }
  run('npm', ['publish', release.tarball, '--registry', registry, '--access', 'public', '--tag', channel], { stdio: 'inherit' })
  // npm scans accepted uploads before making their metadata public.
  await waitForPublished(release)
  return release
}

async function main() {
  const [command, tag, ...extra] = process.argv.slice(2)
  if (extra.length || !['check', 'pack', 'publish'].includes(command)) {
    throw new Error('Usage: release.mjs check|pack|publish <package>/v<version>')
  }
  const release = await ({ check, pack, publish }[command])(tag)
  if (process.env.GITHUB_OUTPUT) {
    for (const key of ['id', 'name', 'version', 'commit', 'tarball']) {
      if (release[key]) await appendFile(process.env.GITHUB_OUTPUT, `${key}=${release[key]}\n`)
    }
  }
  console.log(JSON.stringify(release, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1 })
}
