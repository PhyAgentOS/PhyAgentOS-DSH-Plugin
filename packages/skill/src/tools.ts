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
      name: 'forge_skill_install_local',
      description:
        'Install a locally built skill bundle (the tar.gz written by forge_skill_package) or update an installed skill from it. Extracts to a staging directory, validates manifest and SKILL.md, refuses to replace a running skill, keeps the previous bundle under <skills>/.backups/<name>/, and swaps atomically. Node artifacts are not fetched here: nodes ship through their own releases.',
      parameters: {
        path: { type: 'string', required: true, description: 'Absolute path to the bundle tar.gz' },
      },
      output: objectOutput,
      async execute(args: { path: string }) {
        try {
          return await ops.installLocal(args.path)
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
      name: 'forge_model_search',
      description: 'Search or list local Forge model weights under <home>/models (or DSH_FORGE_MODELS / models.root). Filter by free text, model id, tag or referencing skill. Read-only.',
      parameters: {
        query: { type: 'string', description: 'Optional free text matched against id, revision, description, tags, files, source and referencing skills' },
        id: { type: 'string', description: 'Optional exact model id filter, e.g. sam3' },
        tag: { type: 'string', description: 'Optional tag filter, e.g. segmentation' },
        skill: { type: 'string', description: 'Optional installed skill name to show only models it references' },
      },
      output: objectOutput,
      async execute(args: { query?: string; id?: string; tag?: string; skill?: string }) {
        try {
          return {
            ok: true,
            ...await ops.modelSearch({
              query: args.query,
              id: args.id,
              tag: args.tag,
              skill: args.skill,
            }),
          }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_model_info',
      description: 'Inspect one local Forge model by id (and optional revision): weight file paths, size, sha256, receipt metadata, available revisions and referencing skills. Read-only.',
      parameters: {
        id: { type: 'string', required: true, description: 'Model id under <modelsRoot>, e.g. sam3' },
        revision: { type: 'string', description: 'Optional revision directory name; defaults to the preferred installed revision' },
      },
      output: objectOutput,
      async execute(args: { id: string; revision?: string }) {
        try {
          return { ok: true, ...await ops.modelInfo(args.id, args.revision) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_model_verify',
      description: 'Verify a local Forge model weight file by hashing it with SHA256 and comparing against its receipt.json. Read-only.',
      parameters: {
        id: { type: 'string', required: true, description: 'Model id under <modelsRoot>, e.g. sam3' },
        revision: { type: 'string', description: 'Optional revision directory name' },
      },
      output: objectOutput,
      async execute(args: { id: string; revision?: string }) {
        try {
          return await ops.modelVerify(args.id, args.revision)
        } catch (error) {
          return failure(error)
        }
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
      name: 'forge_skill_package',
      description:
        'Package one installed skill bundle into a deterministic tar.gz (sorted entries, pinned timestamps/ownership, sha256 sidecar, archive-manifest.json). Writes under the forge home by default; reports the digest a node/skill lock would record. Node binaries are distributed through their own releases, not here.',
      parameters: {
        name: { type: 'string', required: true, description: 'Installed skill name to package' },
        output_dir: { type: 'string', description: 'Destination directory; defaults to <forge home>/runtime/dist' },
        force: { type: 'boolean', description: 'Replace an existing archive of the same name/version' },
        include_venv: { type: 'boolean', description: 'Ship venv trees too (off by default: they embed absolute paths)' },
      },
      output: objectOutput,
      async execute(args: { name: string; output_dir?: string; force?: boolean; include_venv?: boolean }) {
        try {
          const result = await ops.packageSkill(args.name, {
            ...(args.output_dir === undefined ? {} : { outputDir: args.output_dir }),
            ...(args.force === undefined ? {} : { force: args.force }),
            ...(args.include_venv === undefined ? {} : { includeVenv: args.include_venv }),
          })
          return result
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
      name: 'forge_environment_check',
      description: 'Check the local base environment for Forge before running any skill: Forge 1/2 dora CLIs and versions, Node/Python, data-root writability and free disk, registry reachability, the gateway ports installed skills declare, and DSH_FORGE_* variables. Use right after installing the plugin, or when a skill fails to start with FORGE_NODE_MISSING. Read-only; returns per-check FORGE_ENV_* codes with fix hints.',
      parameters: {
        offline: { type: 'boolean', description: 'Skip the registry probe (air-gapped machines)' },
      },
      output: objectOutput,
      async execute(args: { offline?: boolean }) {
        try {
          return await ops.environmentCheck({ offline: args.offline === true })
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_environment_setup',
      description: 'Bootstrap Forge base runtime dependencies on a new or incomplete machine: ensures <home>/{skills,models,support/bin,runtime}, installs pinned Forge 1 dora (0.4.1) and Forge 2 dora1 (1.0.1) into isolated venvs under <home>/support/ (or copies provided local binaries), optionally updates cordis.patch.yml, and re-runs forge_environment_check. Existing healthy binaries are kept unless force=true. Pass dry_run=true to preview the plan without changes.',
      parameters: {
        dry_run: { type: 'boolean', description: 'Preview the setup plan without creating directories or installing packages' },
        components: {
          type: 'array',
          items: { type: 'string', enum: ['directories', 'dora', 'dora1', 'profileConfig'] },
          description: 'Optional subset of components to set up; default is directories, dora, dora1 (plus profileConfig if write_profile_config=true)',
        },
        dora_version: { type: 'string', description: 'Forge 1 dora-rs-cli version (default 0.4.1)' },
        dora1_version: { type: 'string', description: 'Forge 2 dora-rs-cli version (default 1.0.1)' },
        dora_binary_path: { type: 'string', description: 'Optional local Forge 1 dora executable to install instead of downloading' },
        dora1_binary_path: { type: 'string', description: 'Optional local Forge 2 dora1 executable to install instead of downloading' },
        python: { type: 'string', description: 'Optional Python interpreter or version (e.g. 3.12 or python3.12)' },
        index_url: { type: 'string', description: 'Optional PyPI mirror index URL (e.g. https://pypi.tuna.tsinghua.edu.cn/simple)' },
        force: { type: 'boolean', description: 'Reinstall even when an existing dora/dora1 already passes version check' },
        write_profile_config: { type: 'boolean', description: 'Also write runtime.dora / runtime.dora1 into the DSH profile cordis.patch.yml' },
        profile: { type: 'string', description: 'DSH profile name for write_profile_config (defaults to current profile or web)' },
        offline: { type: 'boolean', description: 'Skip registry probe during post-setup environment verification' },
      },
      output: objectOutput,
      async execute(args: {
        dry_run?: boolean
        components?: Array<'directories' | 'dora' | 'dora1' | 'profileConfig'>
        dora_version?: string
        dora1_version?: string
        dora_binary_path?: string
        dora1_binary_path?: string
        python?: string
        index_url?: string
        force?: boolean
        write_profile_config?: boolean
        profile?: string
        offline?: boolean
      }) {
        try {
          return await ops.environmentSetup({
            dryRun: args.dry_run === true,
            components: args.components,
            doraVersion: args.dora_version,
            dora1Version: args.dora1_version,
            doraBinaryPath: args.dora_binary_path,
            dora1BinaryPath: args.dora1_binary_path,
            python: args.python,
            indexUrl: args.index_url,
            force: args.force === true,
            writeProfileConfig: args.write_profile_config === true,
            profile: args.profile,
            offline: args.offline === true,
          })
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_config_read',
      description: 'Read the forge-skill plugin configuration from a DSH profile cordis.patch.yml, plus available profiles and backups. Read-only.',
      parameters: {
        profile: { type: 'string', description: 'DSH profile name (defaults to active profile or web)' },
      },
      output: objectOutput,
      async execute(args: { profile?: string }) {
        try {
          return { ok: true, ...await ops.configRead(args.profile) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_config_write',
      description: 'Safely update the forge-skill plugin configuration in a DSH profile cordis.patch.yml (home, skills, models, registry, runtime, gateway, ui). Validates schema, preserves unrelated rows/comments, keeps a timestamped backup and returns a field-level diff. Merges onto existing forge-skill config by default (set merge=false to replace).',
      parameters: {
        profile: { type: 'string', description: 'DSH profile name (defaults to active profile or web)' },
        config: { type: 'object', required: true, additionalProperties: true, description: 'Forge plugin config object (e.g. { runtime: { dora, dora1 }, models: { root }, registry: { url } })' },
        merge: { type: 'boolean', description: 'Merge onto existing forge-skill config (default true); false replaces the whole config block' },
      },
      output: objectOutput,
      async execute(args: { profile?: string; config: Record<string, unknown>; merge?: boolean }) {
        try {
          return { ok: true, ...await ops.configWrite(args.profile, args.config, { merge: args.merge !== false }) }
        } catch (error) {
          return failure(error)
        }
      },
    })),

    ctx.tools.register(defineTool({
      name: 'forge_config_restore',
      description: 'Restore a previous cordis.patch.yml.bak-* backup for a DSH profile (keeping the current file as a new backup first).',
      parameters: {
        profile: { type: 'string', description: 'DSH profile name (defaults to active profile or web)' },
        backup: { type: 'string', required: true, description: 'Backup filename from forge_config_read, e.g. cordis.patch.yml.bak-...' },
      },
      output: objectOutput,
      async execute(args: { profile?: string; backup: string }) {
        try {
          return { ok: true, ...await ops.configRestore(args.profile, args.backup) }
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
