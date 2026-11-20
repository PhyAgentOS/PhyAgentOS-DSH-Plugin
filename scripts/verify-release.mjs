#!/usr/bin/env node
/** Verify release invariants in the source tree and, when present, dist/publish. */
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import semver from 'semver'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const problems = []
const check = (condition, message) => { if (!condition) problems.push(message) }
const exists = async path => { try { await stat(path); return true } catch { return false } }

const core = JSON.parse(await readFile(join(root, 'packages/core/package.json'), 'utf8'))
const skill = JSON.parse(await readFile(join(root, 'packages/skill/package.json'), 'utf8'))
const cli = JSON.parse(await readFile(join(root, 'packages/cli/package.json'), 'utf8'))
const mcp = JSON.parse(await readFile(join(root, 'packages/mcp/package.json'), 'utf8'))
const bundle = JSON.parse(await readFile(join(root, 'bundle/package.json'), 'utf8'))

for (const [label, manifest] of [['core', core], ['skill', skill], ['cli', cli], ['mcp', mcp], ['bundle', bundle]]) {
  check(typeof manifest.name === 'string' && manifest.name.startsWith('@x-era/'), `${label}: name must be @x-era/*`)
  check(semver.valid(manifest.version) === manifest.version, `${label}: version must be semver`)
  check(manifest.type === 'module', `${label}: type must be module`)
  check(manifest.repository?.url === 'git+https://github.com/PhyAgentOS/PhyAgentOS-DSH-Plugin.git', `${label}: repository must identify the public source`)
}

check(skill.dsh?.client?.platform === 'web', 'skill: dsh.client.platform must be web')
check(skill.exports?.['./client'] !== undefined, 'skill: must export ./client')
check(await exists(join(root, 'packages/skill/lib/client.js')), 'skill: lib/client.js is missing (run build)')
if (await exists(join(root, 'packages/skill/lib/client.js'))) {
  const client = await readFile(join(root, 'packages/skill/lib/client.js'), 'utf8')
  check(client.includes('window.__ModuleLoader__.load'), 'skill: client bundle must register via __ModuleLoader__.load')
  check(client.includes(skill.name), 'skill: client bundle id must equal the package name')
}

check(typeof cli.bin?.forge === 'string', 'cli: bin.forge is required')
check(typeof mcp.bin?.['forge-mcp'] === 'string', 'mcp: bin.forge-mcp is required')

check(bundle.dsh?.bundle?.patch === './cordis.patch.yml', 'bundle: dsh.bundle.patch must point at cordis.patch.yml')
check(await exists(join(root, 'bundle/cordis.patch.yml')), 'bundle: cordis.patch.yml is missing')
check(bundle.files?.includes('cordis.patch.yml'), 'bundle: files must include cordis.patch.yml')
check(typeof bundle.engines?.dsh === 'string' && bundle.engines.dsh.length > 0, 'bundle: engines.dsh is required')
// Source may keep `file:` links for local development; the staged copy is the publish unit.

const dist = join(root, 'dist/publish')
if (await exists(dist)) {
  for (const name of [core.name, skill.name, cli.name, mcp.name, bundle.name]) {
    const manifestPath = join(dist, name, 'package.json')
    check(await exists(manifestPath), `dist: ${name} is not staged`)
    if (await exists(manifestPath)) {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      const source = [core, skill, cli, mcp, bundle].find(item => item.name === name)
      check(manifest.version === source.version, `dist: ${name} version differs from source`)
      check(manifest.private !== true && manifest.publishConfig?.access === 'public', `dist: ${name} must be public`)
      check(await exists(join(dist, name, 'LICENSE')), `dist: ${name} LICENSE missing`)
      check(await exists(join(dist, name, 'README.md')), `dist: ${name} README missing`)
      for (const [dep, spec] of Object.entries(manifest.dependencies ?? {})) {
        check(!String(spec).startsWith('file:') && !String(spec).startsWith('workspace:'),
          `dist: ${name} dependency ${dep} is not pinned (${spec})`)
      }
      if (name === skill.name) {
        check(await exists(join(dist, name, 'lib/client.js')), 'dist: skill lib/client.js missing')
      }
    }
  }
}

if (problems.length > 0) {
  console.error('release verification failed:')
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log('release verification passed')
