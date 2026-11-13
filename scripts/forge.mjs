#!/usr/bin/env node
/**
 * Local runner for forge skills without a DSH host.
 *
 *   node scripts/forge.mjs list
 *   node scripts/forge.mjs status [skill]
 *   node scripts/forge.mjs start <skill> <profile>
 *   node scripts/forge.mjs call <skill> <tool_id> ['{"k":1}']
 *   node scripts/forge.mjs context <skill> <tool_id>
 *   node scripts/forge.mjs stop <skill>
 *
 * Uses the same core as the DSH plugin, so runtime state is shared with it.
 */
import { join } from 'node:path'

import {
  ForgeCatalog,
  ForgeRegistryClient,
  ForgeToolClient,
  SkillRuntimeManager,
  forgePaths,
  resolveForgeHome,
} from '../packages/core/lib/index.js'

const home = resolveForgeHome()
const paths = forgePaths(home)
const catalog = new ForgeCatalog(paths.skills)
const registry = new ForgeRegistryClient()
const runtime = new SkillRuntimeManager({
  home,
  catalog,
  registry,
  startTimeoutMs: 180000,
})

const [command, ...args] = process.argv.slice(2)
await runtime.load()

switch (command) {
  case 'list': {
    const { skills, diagnostics } = await catalog.list()
    for (const skill of skills) {
      const state = await runtime.status(skill.name)
      console.log(`${skill.name.padEnd(34)} ${skill.manifest.version.padEnd(8)} ${(state?.status ?? 'stopped').padEnd(8)} ${Object.keys(skill.manifest.profiles).join(',')}`)
    }
    for (const issue of diagnostics) console.log(`! ${issue.name}: ${issue.code} ${issue.message}`)
    break
  }
  case 'status': {
    const names = args[0] === undefined ? [...(await catalog.list()).skills.map(skill => skill.name)] : [args[0]]
    for (const name of names) console.log(name, JSON.stringify(await runtime.status(name) ?? null))
    break
  }
  case 'start': {
    const [skill, profile] = args
    if (skill === undefined || profile === undefined) fail('usage: start <skill> <profile>')
    const state = await runtime.start(skill, profile)
    console.log(JSON.stringify(state, null, 2))
    break
  }
  case 'stop': {
    const [skill] = args
    if (skill === undefined) fail('usage: stop <skill>')
    console.log(JSON.stringify(await runtime.stop(skill) ?? null, null, 2))
    break
  }
  case 'context': {
    const [skill, toolId] = args
    if (skill === undefined || toolId === undefined) fail('usage: context <skill> <tool_id>')
    const client = await clientFor(skill)
    console.log(JSON.stringify(await client.context(toolId), null, 2))
    break
  }
  case 'call': {
    const [skill, toolId, raw] = args
    if (skill === undefined || toolId === undefined) fail('usage: call <skill> <tool_id> [json]')
    const client = await clientFor(skill)
    const result = await client.invoke(toolId, raw === undefined ? {} : JSON.parse(raw))
    console.log(JSON.stringify(result, null, 2))
    break
  }
  default:
    fail('commands: list | status | start | stop | context | call')
}

async function clientFor(skill) {
  const state = await runtime.status(skill)
  if (state === undefined || state.status !== 'healthy') fail(`skill "${skill}" has no healthy runtime (start it first)`)
  return new ForgeToolClient(state.gatewayUrl)
}

function fail(message) {
  console.error(message)
  process.exit(1)
}
