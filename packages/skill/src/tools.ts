import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ForgeError, type ForgeOperations } from '@x-era/forge-core'

const objectOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

export interface ForgeToolDeps {
  readonly operations: ForgeOperations
  readonly roots: readonly string[]
  readonly dynamic?: { refresh(skill: string): Promise<{ registered: string[]; skipped?: string }>; dispose(skill: string): void; disposeAll(): void } | undefined
}

/** Translate a thrown ForgeError into a structured tool result. */
function failure(error: unknown): { ok: false; code: string; message: string } {
  if (error instanceof ForgeError) return { ok: false, code: error.code, message: error.message }
  return { ok: false, code: 'FORGE_INTERNAL', message: (error as Error).message }
}

/**
 * The DSH adapter: schemas and descriptions only. Every capability lives in
 * `ForgeOperations`, shared with the CLI and the MCP server.
 */
export function registerForgeTools(ctx: Context, deps: ForgeToolDeps): Array<() => void> {
  const ops = deps.operations

  return [
    ctx.tools.register(defineTool({
      name: 'forge_skill_list',
      description: 'List installed Forge skills, their runtime state, and bundles that could not be parsed. Read-only.',
      parameters: {},
      output: objectOutput,
      async execute() {
        const listing = await ops.list()
        return { roots: deps.roots, ...listing }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_skill_inspect',
      description: 'Inspect one installed Forge skill: profiles, required binaries/assets, artifact locks and static checks. Read-only.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name (not a filesystem path)' },
      },
      output: objectOutput,
      async execute(args: { name: string }) {
        try {
          return await ops.inspect(args.name)
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_skill_read',
      description: 'Read the instruction document (SKILL.md) of an installed Forge skill. Read-only.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name (not a filesystem path)' },
      },
      output: objectOutput,
      async execute(args: { name: string }) {
        try {
          return { ok: true, ...await ops.read(args.name) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_skill_search',
      description: 'Search the Forge resource registry for installable skills. Read-only.',
      parameters: {
        query: { type: 'string', description: 'Optional search text; empty lists everything' },
      },
      output: objectOutput,
      async execute(args: { query?: string }) {
        try {
          return { ok: true, registry: ops.registry.baseUrl, skills: await ops.search(args.query ?? '') }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_skill_install',
      description: 'Install or update a Forge skill as a background job: resumable download (sha256/size verified), unpack, validate, swap into place, then install locked node artifacts. Returns a job id; poll forge_install_status.',
      parameters: {
        name: { type: 'string', required: true, description: 'Registry skill name, e.g. robot-control-sim' },
        nodes: { type: 'boolean', description: 'Also install locked node artifacts (default true)' },
        version: { type: 'string', description: 'Pin a published version instead of the current one' },
      },
      output: objectOutput,
      async execute(args: { name: string; nodes?: boolean; version?: string }) {
        try {
          const record = ops.install(args.name, args.nodes !== false, args.version)
          return { ok: true, jobId: record.id, state: record.state, hint: 'poll forge_install_status with this job id' }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_install_status',
      description: 'Read one install job (phase, bytes, error) or the most recent jobs. Read-only.',
      parameters: {
        job_id: { type: 'string', description: 'Job id returned by forge_skill_install' },
      },
      output: objectOutput,
      async execute(args: { job_id?: string }) {
        if (args.job_id !== undefined) return { ok: true, job: await ops.jobStatus(args.job_id) }
        return { ok: true, jobs: await ops.jobList(10) }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_install_cancel',
      description: 'Request cancellation of a running install job. A cancelled download leaves its partial file for a later resume.',
      parameters: {
        job_id: { type: 'string', required: true, description: 'Job id' },
      },
      output: objectOutput,
      async execute(args: { job_id: string }) {
        const cancelled = ops.cancelJob(args.job_id)
        return { ok: cancelled, job: await ops.jobStatus(args.job_id) }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_skill_update',
      description: 'Compare an installed skill with the registry version. With apply=true, starts the same background install job to replace it.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name' },
        apply: { type: 'boolean', description: 'Start the update job when a newer version exists' },
        version: { type: 'string', description: 'Target a specific published version' },
      },
      output: objectOutput,
      async execute(args: { name: string; apply?: boolean; version?: string }) {
        try {
          return { ok: true, ...await ops.update(args.name, args.apply === true, args.version) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_cache_summary',
      description: 'Summarize the node artifact cache: one row per artifact and the total size. Read-only.',
      parameters: {},
      output: objectOutput,
      async execute() {
        return { ok: true, nodesRoot: ops.paths.nodes, ...await ops.cacheSummary() }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_cache_gc',
      description: 'Remove cached node artifacts that no installed skill references. dry_run=true only measures. Never touches skills or running runtimes.',
      parameters: {
        dry_run: { type: 'boolean', description: 'Measure only' },
      },
      output: objectOutput,
      async execute(args: { dry_run?: boolean }) {
        const result = await ops.cacheGc(args.dry_run === true)
        return { ok: true, dryRun: args.dry_run === true, ...result }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_skill_remove',
      description: 'Remove an installed Forge skill. Requires its runtime to be stopped first.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name' },
      },
      output: objectOutput,
      async execute(args: { name: string }) {
        try {
          return { ok: true, ...await ops.remove(args.name) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_profile_files',
      description: 'List editable profile files (YAML/JSON/Markdown under profiles/<id>/) of an installed skill. Read-only; use forge_profile_read to see a file.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name' },
        profile: { type: 'string', description: 'Optional profile id to filter' },
      },
      output: objectOutput,
      async execute(args: { name: string; profile?: string }) {
        try {
          const tree = await ops.profileTree()
          const skill = tree.find(item => item.name === args.name)
          if (skill === undefined) return { ok: false, code: 'FORGE_SKILL_NOT_FOUND', message: `skill "${args.name}" is not installed` }
          const profiles = args.profile === undefined ? skill.profiles : skill.profiles.filter(item => item.id === args.profile)
          if (args.profile !== undefined && profiles.length === 0) return { ok: false, code: 'FORGE_PROFILE_UNKNOWN', message: `profile "${args.profile}" does not exist` }
          return { ok: true, skill: skill.name, version: skill.version, profiles }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_profile_read',
      description: 'Read one profile file with its parsed validity. Read-only. Use it before changing a skill profile.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name' },
        profile: { type: 'string', required: true, description: 'Profile id, e.g. mujoco-piper' },
        file: { type: 'string', required: true, description: 'Path inside the profile directory, e.g. simulator.yaml' },
      },
      output: objectOutput,
      async execute(args: { name: string; profile: string; file: string }) {
        try {
          return { ok: true, ...await ops.profileRead(args.name, args.profile, args.file) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_profile_write',
      description: 'Write one profile file: validates YAML/JSON, backs up the previous file, returns the field-level diff. The change takes effect after the skill runtime is restarted.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name' },
        profile: { type: 'string', required: true, description: 'Profile id' },
        file: { type: 'string', required: true, description: 'Path inside the profile directory' },
        content: { type: 'string', required: true, description: 'Full new file content' },
      },
      output: objectOutput,
      async execute(args: { name: string; profile: string; file: string; content: string }) {
        try {
          return { ok: true, ...await ops.profileWrite(args.name, args.profile, args.file, args.content) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_skill_versions',
      description: 'List every published version of a skill from the registry, plus the current one. Read-only.',
      parameters: {
        name: { type: 'string', required: true, description: 'Registry skill name' },
      },
      output: objectOutput,
      async execute(args: { name: string }) {
        try {
          return { ok: true, ...await ops.listSkillVersions(args.name) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_repo_search',
      description: 'Search the node repository catalog (framework, adapters, operators): which repository produces a node, its key source paths and endpoints. Read-only.',
      parameters: {
        query: { type: 'string', description: 'Free text: repository name, node id, endpoint, keyword' },
        category: { type: 'string', description: 'Optional: framework | adapter | operator | benchmark' },
      },
      output: objectOutput,
      async execute(args: { query?: string; category?: string }) {
        const entries = ops.listRepositories(args.query, args.category)
        return {
          ok: true,
          count: entries.length,
          repositories: entries.map(entry => ({
            id: entry.id,
            category: entry.category,
            role: entry.role,
            url: entry.url,
            nodes: entry.nodes,
            endpoints: entry.endpoints,
          })),
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_repo_info',
      description: 'Read one node repository entry: description, key source paths, produced nodes, endpoints/operations and inspected snapshot. Accepts a repository id or a node id. Read-only.',
      parameters: {
        id_or_node: { type: 'string', required: true, description: 'Repository id (adapter-forge-gateway) or node id (gateway)' },
      },
      output: objectOutput,
      async execute(args: { id_or_node: string }) {
        const entry = ops.repository(args.id_or_node)
        if (entry === undefined) return { ok: false, code: 'FORGE_REPO_NOT_FOUND', message: `no catalog entry for "${args.id_or_node}"` }
        return { ok: true, ...entry }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_node_source',
      description: 'Read a source file from the registry-pinned revision of a node artifact (default README.md). Requires the updated registry source pinning; results are cached per commit. Read-only.',
      parameters: {
        artifact_id: { type: 'string', required: true, description: 'Artifact id, e.g. gateway-1.0.2-linux-x86_64-tar-gz' },
        file: { type: 'string', description: 'Path inside the repository, default README.md' },
        refresh: { type: 'boolean', description: 'Bypass the local cache' },
      },
      output: objectOutput,
      async execute(args: { artifact_id: string; file?: string; refresh?: boolean }) {
        try {
          return { ok: true, ...await ops.nodeSource(args.artifact_id, args.file ?? 'README.md', args.refresh === true) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_skill_docs',
      description: 'List or read the documentation shipped inside an installed skill (docs/**, SKILL.md, skill.yaml, README.md). Read-only; omit file to list.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name' },
        file: { type: 'string', description: 'Optional document path to read' },
      },
      output: objectOutput,
      async execute(args: { name: string; file?: string }) {
        try {
          if (args.file === undefined) return { ok: true, ...await ops.skillDocs(args.name) }
          return { ok: true, ...await ops.readSkillDoc(args.name, args.file) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_skill_validate',
      description: 'Validate a skill bundle directory before installing it: manifest, instruction document, profile dataflows/assets, artifact locks and path containment. Read-only.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute path to the bundle directory' },
      },
      output: objectOutput,
      async execute(args: { path: string }) {
        try {
          return await ops.validateLocalBundle(args.path)
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_node_info',
      description: 'Look up a locked node artifact in the registry: version, display name, source repository and digest. Read-only.',
      parameters: {
        artifact_id: { type: 'string', required: true, description: 'Artifact id from forge_skill_inspect, e.g. gateway-1.0.2-linux-x86_64-tar-gz' },
      },
      output: objectOutput,
      async execute(args: { artifact_id: string }) {
        try {
          return { ok: true, ...await ops.nodeInfo(args.artifact_id) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_skill_doctor',
      description: 'Diagnose why a Forge skill cannot run: static structure, artifact availability, environment, port and runtime/gateway/tool coverage. Read-only; returns stable FORGE_* codes and fix hints.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name' },
        profile: { type: 'string', description: 'Optional profile id; defaults to the first profile' },
      },
      output: objectOutput,
      async execute(args: { name: string; profile?: string }) {
        try {
          return await ops.doctor(args.name, args.profile)
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_doctor_report',
      description: 'Write a JSON operations report for installed skills: static checks, runtime state, gateway coverage and config summary with secrets redacted. Read-only apart from the report file.',
      parameters: {
        name: { type: 'string', description: 'Optional single skill; default is every installed skill' },
      },
      output: objectOutput,
      async execute(args: { name?: string }) {
        try {
          return { ok: true, ...await ops.doctorReport(args.name) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_runtime_start',
      description: 'Start a Forge skill runtime (Dora dataflow) for one profile and wait until its Gateway reports readiness. mode=start (default) uses the coordinator; mode=run launches an isolated local process. May move real hardware when the skill is not a simulation profile.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name' },
        profile: { type: 'string', required: true, description: 'Profile id from the manifest' },
        mode: { type: 'string', enum: ['start', 'run'], description: 'start (coordinator, default) or run (isolated local process)' },
      },
      output: objectOutput,
      async execute(args: { name: string; profile: string; mode?: 'start' | 'run' }) {
        try {
          const runtime = await ops.runtimeStart(args.name, args.profile, args.mode ?? 'start')
          if (deps.dynamic !== undefined) await deps.dynamic.refresh(args.name)
          return { ok: true, runtime }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_runtime_status',
      description: 'Read the persisted runtime state of one Forge skill, including flow name and gateway URL. Read-only.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name' },
      },
      output: objectOutput,
      async execute(args: { name: string }) {
        return { ok: true, runtime: await ops.runtimeStatus(args.name) }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_runtime_stop',
      description: 'Stop the runtime of one Forge skill through Dora. Rejects when tracked work is still active unless force is true.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name' },
        force: { type: 'boolean', description: 'Force stop' },
      },
      output: objectOutput,
      async execute(args: { name: string; force?: boolean }) {
        try {
          const runtime = await ops.runtimeStop(args.name, args.force === true)
          deps.dynamic?.dispose(args.name)
          return { ok: true, runtime }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_runtime_logs',
      description: 'Read the tail of a skill runtime log. Read-only.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name' },
        lines: { type: 'integer', description: 'Line count, default 120' },
      },
      output: objectOutput,
      async execute(args: { name: string; lines?: number }) {
        return { ok: true, name: args.name, log: await ops.runtimeLogs(args.name, args.lines ?? 120) }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_tool_context',
      description: 'Read the live ToolSpec context (frames, units, readiness) of a running Forge skill without invoking anything. Read-only.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name with a healthy runtime' },
        tool_id: { type: 'string', required: true, description: 'Tool id such as sim.get_robot_info' },
      },
      output: objectOutput,
      async execute(args: { name: string; tool_id: string }) {
        try {
          return { ok: true, tool_id: args.tool_id, context: await ops.toolContext(args.name, args.tool_id) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_tool_call',
      description: 'Invoke a Forge tool on a running skill. Query tools answer synchronously; action/session tools return an invocation id to read with forge_invocation_read. A timeout or unknown outcome must not be retried blindly.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name with a healthy runtime' },
        tool_id: { type: 'string', required: true, description: 'Tool id such as sim.move_eef' },
        arguments: { type: 'object', additionalProperties: true, description: 'Tool arguments object' },
      },
      output: objectOutput,
      async execute(args: { name: string; tool_id: string; arguments?: Record<string, unknown> }) {
        try {
          return await ops.toolCall(args.name, args.tool_id, args.arguments ?? {})
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_invocation_read',
      description: 'Read status and result of a Forge invocation. Read-only; never repeats the action.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name with a healthy runtime' },
        invocation_id: { type: 'string', required: true, description: 'Invocation id returned by forge_tool_call' },
      },
      output: objectOutput,
      async execute(args: { name: string; invocation_id: string }) {
        try {
          return { ok: true, ...await ops.invocationRead(args.name, args.invocation_id) }
        } catch (error) {
          return failure(error)
        }
      },
    })),
  ]
}
