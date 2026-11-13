#!/usr/bin/env node
/** Smoke: drive the real DSH tool handlers over ForgeOperations against a temp home. */
import { register } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ForgeOperations, forgePaths } from '../packages/core/lib/index.js'

register('./support/stub-loader.mjs', import.meta.url)
const { registerForgeTools } = await import('../packages/skill/lib/tools.js')

const home = await mkdtemp(join(tmpdir(), 'forge-m5-'))
const paths = forgePaths(home)
const operations = new ForgeOperations({ home })
const tools = new Map()
const ctx = {
  tools: { register: definition => { tools.set(definition.name, definition); return () => undefined } },
}
registerForgeTools(ctx, { operations, roots: [paths.skills] })

const call = (name, args) => tools.get(name).execute(args, {})

try {
  const started = await call('forge_skill_install', { name: 'control-unitree-go2', nodes: false })
  console.log('install start:', JSON.stringify(started))
  const status = await operations.jobs.wait(started.jobId)
  console.log('install end:', JSON.stringify({ state: status?.state, result: status?.result }))

  const list = await call('forge_skill_list', {})
  console.log('catalog:', list.skills.map(skill => skill.name).join(', '))

  const update = await call('forge_skill_update', { name: 'control-unitree-go2' })
  console.log('update:', JSON.stringify(update))

  console.log('cache summary:', JSON.stringify(await call('forge_cache_summary', {})))
  console.log('cache gc dry:', JSON.stringify(await call('forge_cache_gc', { dry_run: true })))

  const toCancel = await call('forge_skill_install', { name: 'robot-control-sim', nodes: false })
  await new Promise(resolveWait => setTimeout(resolveWait, 50))
  const cancel = await call('forge_install_cancel', { job_id: toCancel.jobId })
  const cancelled = await operations.jobs.wait(toCancel.jobId)
  console.log('cancel:', JSON.stringify({ requested: cancel.ok, state: cancelled?.state }))

  const report = await call('forge_doctor_report', {})
  console.log('doctor report:', JSON.stringify(report))
  const eventLines = (await readFile(join(paths.runtime, 'logs', 'events.jsonl'), 'utf8')).trim().split('\n').length
  console.log('event log lines:', eventLines)

  const exported = await operations.exportPortable('control-unitree-go2', join(home, 'portable'))
  const head = (await readFile(join(exported.path, 'SKILL.md'), 'utf8')).split('\n').slice(0, 8).join('\n')
  console.log('portable export:', exported.path)
  console.log(head)
} finally {
  await rm(home, { recursive: true, force: true })
}
