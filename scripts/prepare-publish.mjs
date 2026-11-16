#!/usr/bin/env node
/**
 * Stage publishable packages under dist/publish/.
 *
 * The working tree keeps `file:` links so `dsh plugin add ./bundle` works
 * locally; the staged copy rewrites them to exact versions and drops anything
 * that must not ship.
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'dist/publish')

const packageDirs = [
  join(root, 'packages/core'),
  join(root, 'packages/skill'),
  join(root, 'packages/cli'),
  join(root, 'packages/mcp'),
]
const bundleDir = join(root, 'bundle')

await rm(out, { recursive: true, force: true })
await mkdir(out, { recursive: true })

const versions = new Map()
for (const dir of packageDirs) {
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  versions.set(manifest.name, manifest.version)
}

for (const dir of packageDirs) {
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'))
  const target = join(out, manifest.name)
  await mkdir(target, { recursive: true })
  for (const sub of ['lib', 'bin']) {
    if (await exists(join(dir, sub))) await cp(join(dir, sub), join(target, sub), { recursive: true })
  }
  await cp(join(root, 'LICENSE'), join(target, 'LICENSE'))
  await cp(join(dir, 'package.json'), join(target, 'package.json'))
  await cp(join(root, 'README.md'), join(target, 'README.md'))
  rewriteLinks(manifest, versions)
  manifest.publishConfig = { ...(manifest.publishConfig ?? {}), access: 'public' }
  await writeFile(join(target, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}

const bundleManifest = JSON.parse(await readFile(join(bundleDir, 'package.json'), 'utf8'))
const target = join(out, bundleManifest.name)
await mkdir(target, { recursive: true })
await cp(join(root, 'LICENSE'), join(target, 'LICENSE'))
await cp(join(bundleDir, 'cordis.patch.yml'), join(target, 'cordis.patch.yml'))
await cp(join(root, 'README.md'), join(target, 'README.md'))
bundleManifest.dependencies = Object.fromEntries(
  Object.entries(bundleManifest.dependencies ?? {}).map(([name]) => {
    const version = versions.get(name)
    if (version === undefined) throw new Error(`bundle depends on unpublished package ${name}`)
    return [name, version]
  }),
)
bundleManifest.publishConfig = { ...(bundleManifest.publishConfig ?? {}), access: 'public' }
await writeFile(join(target, 'package.json'), `${JSON.stringify(bundleManifest, null, 2)}\n`)

function rewriteLinks(manifest, versions) {
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const table = manifest[section]
    if (table === undefined) continue
    for (const [name, spec] of Object.entries(table)) {
      if (!String(spec).startsWith('file:') && !String(spec).startsWith('workspace:')) continue
      const version = versions.get(name)
      if (version === undefined) throw new Error(`${manifest.name} depends on unstaged package ${name}`)
      table[name] = version
    }
  }
}

const staged = []
async function collect(dir, prefix) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) await collect(join(dir, entry.name), `${prefix}${entry.name}/`)
    else if (entry.name === 'package.json') staged.push(prefix)
  }
}
await collect(out, '')
console.log(`staged ${staged.length} packages under dist/publish:`)
for (const name of staged.sort()) console.log(`  ${name.replace(/\/$/, '')}`)

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
