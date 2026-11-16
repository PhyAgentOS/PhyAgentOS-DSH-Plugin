#!/usr/bin/env node
/** Install real npm tarballs into a disposable DSH profile before publication. */
import { spawnSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { stringify } from 'yaml'
import { packages } from './release.mjs'

const home = process.env.DSH_HOME
const dsh = process.env.DSH_BIN
if (!home || !dsh) throw new Error('Set DSH_HOME to a disposable directory and DSH_BIN to the supported dsh executable')
const profile = join(resolve(home), 'profiles/release-smoke')
const artifacts = join(resolve(home), 'artifacts')
await mkdir(join(resolve(home), 'profiles'), { recursive: true })
await mkdir(profile) // Never overwrite an existing profile.
await mkdir(artifacts, { recursive: true })
const env = { ...process.env, DSH_HOME: resolve(home), DSH_FORGE_HOME: join(resolve(home), 'forge') }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 120000, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`)
  return result.stdout
}
const overrides = {}
for (const id of Object.keys(packages)) {
  const [packed] = JSON.parse(run('npm', ['pack', resolve('dist/publish/@x-era', id), '--json', '--ignore-scripts', '--pack-destination', artifacts]))
  overrides[`@x-era/${id}`] = `file:${join(artifacts, packed.filename)}`
}
await writeFile(join(profile, 'package.json'), JSON.stringify({
  name: 'dsh-profile-release-smoke', private: true, dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
}, null, 2))
await writeFile(join(profile, 'cordis.patch.yml'), '[]\n')
await writeFile(join(profile, 'pnpm-workspace.yaml'), stringify({
  packages: ['.'], nodeLinker: 'hoisted', autoInstallPeers: false, overrides,
}))
const selected = ['dsh-forge', 'forge-cli', 'forge-mcp'].map(id => overrides[`@x-era/${id}`].slice(5))
run(dsh, ['plugin', '--profile', 'release-smoke', 'add', ...selected])
const schema = JSON.parse(run(dsh, ['--profile', 'release-smoke', '--dump-config-schema']))
if (!JSON.stringify(schema).includes('forge-skill')) throw new Error('Forge plugin schema not loaded')
const installed = join(profile, 'node_modules/@x-era')
const help = JSON.parse(run(process.execPath, [join(installed, 'forge-cli/bin/forge.mjs'), '--help']))
if (!help.ok) throw new Error('Installed CLI failed')
const requests = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
]
const replies = run(process.execPath, [join(installed, 'forge-mcp/bin/forge-mcp.mjs')], {
  input: requests.map(request => JSON.stringify(request)).join('\n') + '\n',
}).trim().split('\n').map(line => JSON.parse(line))
if (!replies.some(reply => reply.id === 1 && reply.result?.protocolVersion)
    || !replies.some(reply => reply.id === 2 && reply.result?.tools?.some(tool => tool.name === 'forge_skill_list'))) {
  throw new Error('Installed MCP server did not return protocol and tools')
}
console.log(JSON.stringify({ ok: true, home: resolve(home), profile: 'release-smoke', packages: Object.keys(packages), cli: true, mcp: true, schema: true }))
