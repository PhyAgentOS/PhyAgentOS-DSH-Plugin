#!/usr/bin/env node
/**
 * MCP stdio server for Forge skill management.
 *
 * Newline-delimited JSON-RPC; every tool maps onto ForgeOperations, the same
 * layer the DSH tools and the CLI use. The runtime gateway (Forge Tool API) is
 * still the execution boundary — this server only exposes the management and
 * forwarding surface to non-DSH agent hosts.
 */
import { createInterface } from 'node:readline'

import { ForgeOperations, resolveForgeHome } from '@x-era/forge-core'

const PROTOCOL_VERSION = '2024-11-05'
const home = resolveForgeHome(process.env.DSH_FORGE_HOME)
const operations = new ForgeOperations({ home })
await operations.runtime.load()

const tool = (name, description, properties = {}, required = []) => ({
  name,
  description,
  inputSchema: { type: 'object', properties, required, additionalProperties: false },
})
const str = description => ({ type: 'string', description })
const bool = description => ({ type: 'boolean', description })
const num = description => ({ type: 'number', description })

const TOOLS = [
  tool('forge_skill_list', 'List installed Forge skills and their runtime state.', {}, []),
  tool('forge_skill_search', 'Search the Forge resource registry.', { query: str('Optional search text') }, []),
  tool('forge_skill_inspect', 'Inspect one installed skill (profiles, artifacts, checks).', { name: str('Skill name') }, ['name']),
  tool('forge_skill_read', 'Read the SKILL.md of one installed skill.', { name: str('Skill name') }, ['name']),
  tool('forge_skill_install', 'Install or update a skill as a background job.', { name: str('Registry skill name'), nodes: bool('Also install nodes (default true)'), version: str('Pin a published version') }, ['name']),
  tool('forge_skill_versions', 'List published versions of a skill.', { name: str('Registry skill name') }, ['name']),
  tool('forge_install_status', 'Read one install job or recent jobs.', { job_id: str('Job id') }, []),
  tool('forge_install_cancel', 'Cancel a running install job.', { job_id: str('Job id') }, ['job_id']),
  tool('forge_skill_update', 'Compare installed and registry versions; apply to update.', { name: str('Skill name'), apply: bool('Start the update job'), version: str('Target version') }, ['name']),
  tool('forge_skill_remove', 'Remove an installed skill (runtime stopped first).', { name: str('Skill name') }, ['name']),
  tool('forge_profile_files', 'List editable profile files of a skill.', { name: str('Skill name'), profile: str('Optional profile id') }, ['name']),
  tool('forge_profile_read', 'Read one profile file.', { name: str('Skill name'), profile: str('Profile id'), file: str('File path inside the profile') }, ['name', 'profile', 'file']),
  tool('forge_profile_write', 'Write one profile file (validated, backed up, returns a diff).', { name: str('Skill name'), profile: str('Profile id'), file: str('File path'), content: str('Full new content') }, ['name', 'profile', 'file', 'content']),
  tool('forge_repo_search', 'Search the node repository catalog.', { query: str('Free text'), category: str('framework | adapter | operator | benchmark') }, []),
  tool('forge_repo_info', 'Read one repository entry by repository or node id.', { id_or_node: str('Repository id or node id') }, ['id_or_node']),
  tool('forge_node_source', 'Read a source file from the pinned revision of a node artifact.', { artifact_id: str('Artifact id'), file: str('Path inside the repo, default README.md'), refresh: bool('Bypass cache') }, ['artifact_id']),
  tool('forge_skill_docs', 'List or read documentation shipped inside a skill.', { name: str('Skill name'), file: str('Optional document path') }, ['name']),
  tool('forge_skill_validate', 'Validate a local bundle directory before installing it.', { path: str('Bundle directory') }, ['path']),
  tool('forge_node_info', 'Look up a locked node artifact and its source repository.', { artifact_id: str('Artifact id') }, ['artifact_id']),
  tool('forge_skill_doctor', 'Diagnose one skill.', { name: str('Skill name'), profile: str('Optional profile id') }, ['name']),
  tool('forge_doctor_report', 'Write a JSON diagnostics report for installed skills.', { name: str('Optional skill name') }, []),
  tool('forge_runtime_start', 'Start a skill runtime for one profile and wait until ready.', { name: str('Skill name'), profile: str('Profile id'), mode: { type: 'string', enum: ['start', 'run'], description: 'start (coordinator) or run (isolated)' } }, ['name', 'profile']),
  tool('forge_runtime_status', 'Read runtime state for one skill.', { name: str('Skill name') }, ['name']),
  tool('forge_runtime_stop', 'Stop a skill runtime.', { name: str('Skill name'), force: bool('Force stop') }, ['name']),
  tool('forge_runtime_logs', 'Read the tail of a runtime log.', { name: str('Skill name'), lines: num('Line count, default 120') }, ['name']),
  tool('forge_tool_context', 'Read a ToolSpec context without invoking.', { name: str('Skill name'), tool_id: str('Tool id') }, ['name', 'tool_id']),
  tool('forge_tool_call', 'Invoke a Forge tool on a running skill.', {
    name: str('Skill name'),
    tool_id: str('Tool id'),
    arguments: { type: 'object', description: 'Tool arguments', additionalProperties: true },
  }, ['name', 'tool_id']),
  tool('forge_invocation_read', 'Read status and result of an invocation.', { name: str('Skill name'), invocation_id: str('Invocation id') }, ['name', 'invocation_id']),
  tool('forge_cache_summary', 'Summarize the node cache.', {}, []),
  tool('forge_cache_gc', 'Remove unreferenced node artifacts.', { dry_run: bool('Measure only') }, []),
  tool('forge_skill_export', 'Export a skill as a portable SKILL.md directory.', { name: str('Skill name'), out: str('Output directory') }, ['name']),
]

async function dispatch(name, args) {
  switch (name) {
    case 'forge_skill_list': return operations.list()
    case 'forge_skill_search': return { registry: operations.registry.baseUrl, skills: await operations.search(args.query ?? '') }
    case 'forge_skill_inspect': return operations.inspect(args.name)
    case 'forge_skill_read': return operations.read(args.name)
    case 'forge_skill_install': return operations.install(args.name, args.nodes !== false, args.version)
    case 'forge_skill_versions': return operations.listSkillVersions(args.name)
    case 'forge_install_status': return args.job_id === undefined ? operations.jobList(10) : operations.jobStatus(args.job_id)
    case 'forge_install_cancel': return { cancelled: operations.cancelJob(args.job_id) }
    case 'forge_skill_update': return operations.update(args.name, args.apply === true, args.version)
    case 'forge_skill_remove': return operations.remove(args.name)
    case 'forge_profile_files': return { profiles: (await operations.profileTree()).find(skill => skill.name === args.name)?.profiles ?? [] }
    case 'forge_profile_read': return operations.profileRead(args.name, args.profile, args.file)
    case 'forge_profile_write': return operations.profileWrite(args.name, args.profile, args.file, args.content)
    case 'forge_repo_search': return { repositories: operations.listRepositories(args.query, args.category) }
    case 'forge_repo_info': return operations.repository(args.id_or_node) ?? { error: `no catalog entry for ${args.id_or_node}` }
    case 'forge_node_source': return operations.nodeSource(args.artifact_id, args.file ?? 'README.md', args.refresh === true)
    case 'forge_skill_docs': return args.file === undefined ? operations.skillDocs(args.name) : operations.readSkillDoc(args.name, args.file)
    case 'forge_skill_validate': return operations.validateLocalBundle(args.path)
    case 'forge_node_info': return operations.nodeInfo(args.artifact_id)
    case 'forge_skill_doctor': return operations.doctor(args.name, args.profile)
    case 'forge_doctor_report': return operations.doctorReport(args.name)
    case 'forge_runtime_start': return operations.runtimeStart(args.name, args.profile, args.mode === 'run' ? 'run' : 'start')
    case 'forge_runtime_status': return operations.runtimeStatus(args.name)
    case 'forge_runtime_stop': return operations.runtimeStop(args.name, args.force === true)
    case 'forge_runtime_logs': return { log: await operations.runtimeLogs(args.name, args.lines ?? 120) }
    case 'forge_tool_context': return operations.toolContext(args.name, args.tool_id)
    case 'forge_tool_call': return operations.toolCall(args.name, args.tool_id, args.arguments ?? {})
    case 'forge_invocation_read': return operations.invocationRead(args.name, args.invocation_id)
    case 'forge_cache_summary': return operations.cacheSummary()
    case 'forge_cache_gc': return operations.cacheGc(args.dry_run === true)
    case 'forge_skill_export': return operations.exportPortable(args.name, args.out ?? `${home}/portable`)
    default: throw Object.assign(new Error(`unknown tool ${name}`), { code: 'FORGE_USAGE' })
  }
}

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)

const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', line => {
  if (line.trim().length === 0) return
  let request
  try {
    request = JSON.parse(line)
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })
    return
  }
  const { id, method, params } = request
  if (id === undefined) return // notification
  void handle(method, params ?? {}).then(result => {
    send({ jsonrpc: '2.0', id, result })
  }).catch(error => {
    send({
      jsonrpc: '2.0',
      id,
      error: { code: error.code === 'FORGE_USAGE' ? -32601 : -32603, message: error instanceof Error ? error.message : String(error) },
    })
  })
})

async function handle(method, params) {
  switch (method) {
    case 'initialize':
      return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'forge-mcp', version: '0.1.0' } }
    case 'ping':
      return {}
    case 'tools/list':
      return { tools: TOOLS }
    case 'tools/call': {
      const name = params.name
      try {
        const value = await dispatch(name, params.arguments ?? {})
        return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError: false }
      } catch (error) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ ok: false, code: error.code ?? 'FORGE_ERROR', message: error.message }) }],
          isError: true,
        }
      }
    }
    default:
      throw Object.assign(new Error(`unknown method ${method}`), { code: 'FORGE_USAGE' })
  }
}
