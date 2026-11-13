import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

import { ForgeCatalog, type ForgeSkillEntry } from './catalog.js'
import { diffValues } from './diff.js'
import { validateBundle, type BundleValidation } from './validate.js'
import { diagnoseSkill, type Diagnosis } from './doctor.js'
import { EventLog } from './events.js'
import { ForgeError } from './errors.js'
import { installSkill } from './install.js'
import { JobRunner, type JobRecord } from './jobs.js'
import { withLock } from './lock.js'
import type { ForgeManifest } from './manifest.js'
import { exportPortableSkill, type PortableExport } from './portable.js'
import { forgePaths, type ForgePaths } from './paths.js'
import { findRepository, searchRepositories, type RepositoryEntry } from './repositories.js'
import { ForgeRegistryClient, type RegistrySkillSummary } from './registry.js'
import { SkillRuntimeManager, type RuntimeState } from './runtime.js'
import { SkillFileStore, type SkillTree } from './skill-files.js'
import { ForgeToolClient } from './tool-client.js'

export interface ForgeOperationsOptions {
  readonly home: string
  /** Skill roots; the first one receives installs. Defaults to `<home>/skills`. */
  readonly roots?: readonly string[] | undefined
  readonly registry?: ForgeRegistryClient | undefined
  readonly dora?: string | undefined
  readonly dora1?: string | undefined
  readonly startTimeoutMs?: number | undefined
  readonly callTimeoutMs?: number | undefined
  readonly events?: boolean | undefined
  readonly onCatalogChange?: (() => void) | undefined
}

export interface SkillSummaryRow {
  readonly name: string
  readonly version: string
  readonly description: string
  readonly profiles: readonly string[]
  readonly forgeVersion: string
  readonly path: string
  readonly runtime: RuntimeState | null
}

/**
 * Host-neutral capability layer.
 *
 * The DSH tools, the CLI and the MCP server are all thin adapters over these
 * methods, so validation and locking live in exactly one place.
 */
export class ForgeOperations {
  readonly paths: ForgePaths
  readonly catalog: ForgeCatalog
  readonly catalogs: readonly ForgeCatalog[]
  readonly registry: ForgeRegistryClient
  readonly runtime: SkillRuntimeManager
  readonly files: SkillFileStore
  readonly jobs: JobRunner
  readonly events: EventLog
  private readonly callTimeoutMs: number
  private readonly onCatalogChange: (() => void) | undefined
  private loaded: Promise<void> | undefined

  constructor(options: ForgeOperationsOptions) {
    this.paths = forgePaths(options.home)
    this.registry = options.registry ?? new ForgeRegistryClient()
    const roots = options.roots === undefined || options.roots.length === 0 ? [this.paths.skills] : options.roots
    this.catalogs = roots.map(root => new ForgeCatalog(root))
    this.catalog = this.catalogs[0]!
    this.runtime = new SkillRuntimeManager({
      home: options.home,
      catalog: this.catalog,
      registry: this.registry,
      dora: options.dora,
      dora1: options.dora1,
      startTimeoutMs: options.startTimeoutMs,
    })
    this.files = new SkillFileStore(this.catalog, join(this.paths.runtime, 'backups'))
    this.jobs = new JobRunner(join(this.paths.runtime, 'jobs'))
    this.events = new EventLog(join(this.paths.runtime, 'logs', 'events.jsonl'), options.events !== false)
    this.callTimeoutMs = options.callTimeoutMs ?? 15000
    this.onCatalogChange = options.onCatalogChange
  }

  private changed(): void {
    this.onCatalogChange?.()
  }

  private async ready(): Promise<void> {
    this.loaded ??= this.runtime.load()
    return this.loaded
  }

  private async find(name: string): Promise<{ catalog: ForgeCatalog; entry: ForgeSkillEntry } | undefined> {
    for (const catalog of this.catalogs) {
      const entry = await catalog.load(name)
      if (entry !== undefined) return { catalog, entry }
    }
    return undefined
  }

  // ---- catalog -----------------------------------------------------------

  async list(): Promise<{ skills: SkillSummaryRow[]; diagnostics: unknown[] }> {
    await this.ready()
    const skills: SkillSummaryRow[] = []
    const diagnostics: unknown[] = []
    for (const catalog of this.catalogs) {
      const listing = await catalog.list()
      for (const entry of listing.skills) {
        skills.push({
          name: entry.name,
          version: entry.manifest.version,
          description: entry.manifest.description,
          profiles: Object.keys(entry.manifest.profiles),
          forgeVersion: entry.manifest.forgeVersion ?? '1',
          path: entry.dir,
          runtime: (await this.runtime.status(entry.name)) ?? null,
        })
      }
      for (const diagnostic of listing.diagnostics) {
        diagnostics.push({ name: diagnostic.name, code: diagnostic.code, message: diagnostic.message, path: diagnostic.dir })
      }
    }
    return { skills, diagnostics }
  }

  async inspect(name: string): Promise<Record<string, unknown>> {
    const found = await this.find(name)
    if (found === undefined) throw new ForgeError('FORGE_SKILL_NOT_FOUND', `skill "${name}" is not installed`)
    const inspection = await found.catalog.inspect(name)
    if (inspection === undefined) throw new ForgeError('FORGE_SKILL_NOT_FOUND', `skill "${name}" is not installed`)
    const { entry, checks } = inspection
    return {
      ok: checks.every(check => check.status !== 'fail'),
      name: entry.name,
      version: entry.manifest.version,
      description: entry.manifest.description,
      forgeVersion: entry.manifest.forgeVersion ?? '1',
      gatewayUrl: entry.manifest.gatewayUrl ?? null,
      profiles: Object.values(entry.manifest.profiles).map(profile => ({
        id: profile.id,
        dataflow: profile.dataflow,
        requiredBinaries: profile.requiredBinaries,
        requiredAssets: profile.requiredAssets,
        requiredEnvironment: profile.requiredEnvironment,
        requiredTools: profile.requiredTools ?? entry.manifest.requiredTools,
      })),
      artifacts: Object.values(entry.manifest.artifacts).map(artifact => ({ ...artifact })),
      checks,
    }
  }

  async read(name: string): Promise<{ name: string; version: string; profiles: string[]; content: string }> {
    const found = await this.find(name)
    if (found === undefined) throw new ForgeError('FORGE_SKILL_NOT_FOUND', `skill "${name}" is not installed`)
    const content = await found.catalog.readDocument(name)
    if (content === undefined) throw new ForgeError('FORGE_SKILL_DOC_MISSING', `${name} has no instruction document`)
    return {
      name: found.entry.name,
      version: found.entry.manifest.version,
      profiles: Object.keys(found.entry.manifest.profiles),
      content,
    }
  }

  search(query = ''): Promise<RegistrySkillSummary[]> {
    return this.registry.search(query)
  }

  // ---- install -----------------------------------------------------------

  private lockPath(): string {
    return join(this.paths.runtime, 'forge.lock')
  }

  listSkillVersions(name: string): Promise<Awaited<ReturnType<ForgeRegistryClient['skillVersions']>>> {
    return this.registry.skillVersions(name)
  }

  install(name: string, withNodes = true, version?: string): JobRecord {
    return this.jobs.start('install', name, async job => {
      await this.ready()
      return withLock(this.lockPath(), async () => {
        void this.events.append('install.start', { name, nodes: withNodes })
        job.progress({ phase: 'bundle' })
        const result = await installSkill(name, {
          registry: this.registry,
          skillsRoot: this.paths.skills,
          cacheRoot: join(this.paths.runtime, 'cache'),
          signal: job.signal,
          ...(version === undefined ? {} : { version }),
          onProgress: (phase, downloaded, total) => {
            job.progress({
              phase,
              ...(downloaded === undefined ? {} : { downloadedBytes: downloaded }),
              ...(total === undefined ? {} : { totalBytes: total }),
            })
          },
        })
        this.changed()
        let nodes: unknown = null
        if (withNodes) {
          const found = await this.find(name)
          if (found !== undefined) {
            nodes = await this.runtime.nodes.ensureManifest(found.entry.manifest, undefined, {
              signal: job.signal,
              onProgress: (artifactId, downloaded, total) => {
                job.progress({
                  phase: `node:${artifactId}`,
                  downloadedBytes: downloaded,
                  ...(total === undefined ? {} : { totalBytes: total }),
                })
              },
            })
          }
        }
        void this.events.append('install.finish', { name, version: result.version, bytes: result.bytes, nodes })
        return { ...result, nodes }
      })
    })
  }

  async update(name: string, apply = false, version?: string): Promise<Record<string, unknown>> {
    const found = await this.find(name)
    if (found === undefined) throw new ForgeError('FORGE_SKILL_NOT_FOUND', `skill "${name}" is not installed`)
    const installed = found.entry.manifest.version
    const versions = await this.registry.skillVersions(name)
    const latest = version ?? versions.currentVersion ?? (await this.registry.skill(name)).version
    const updateAvailable = latest !== undefined && latest !== installed
    const available = versions.versions.map(item => item.version)
    if (apply) {
      if (latest === undefined) throw new ForgeError('FORGE_REGISTRY_UNAVAILABLE', 'registry did not report a target version')
      const record = this.install(name, true, latest)
      return { installed, latest, updateAvailable, available, jobId: record.id }
    }
    return { installed, latest: latest ?? null, updateAvailable, available }
  }

  async remove(name: string): Promise<{ name: string; removed: string }> {
    await this.ready()
    const state = await this.runtime.status(name)
    if (state !== undefined && state.status !== 'stopped') {
      throw new ForgeError('FORGE_RUNTIME_STALE', `stop the runtime first (${state.status})`)
    }
    const found = await this.find(name)
    if (found === undefined) throw new ForgeError('FORGE_SKILL_NOT_FOUND', `skill "${name}" is not installed`)
    return withLock(this.lockPath(), async () => {
      await rm(found.entry.dir, { recursive: true, force: true })
      this.changed()
      void this.events.append('skill.remove', { name })
      return { name, removed: found.entry.dir }
    })
  }

  async jobStatus(id: string): Promise<JobRecord | null> {
    return (await this.jobs.get(id)) ?? null
  }

  jobList(limit = 10): Promise<JobRecord[]> {
    return this.jobs.list(limit)
  }

  cancelJob(id: string): boolean {
    return this.jobs.cancel(id)
  }

  // ---- doctor ------------------------------------------------------------

  /** Node repository catalog (static, from the TrackB manuals). */
  listRepositories(query?: string, category?: string): RepositoryEntry[] {
    return searchRepositories({ query, category })
  }

  /** One repository by id or by a node id it produces. */
  repository(idOrNode: string): RepositoryEntry | undefined {
    return findRepository(idOrNode)
  }

  /** Registry metadata for one locked node, including its source pinning. */
  async nodeInfo(artifactId: string): Promise<Record<string, unknown>> {
    const artifact = await this.registry.node(artifactId)
    return {
      artifactId,
      version: artifact.version ?? null,
      displayName: artifact.displayName ?? null,
      nodeType: artifact.nodeType ?? null,
      sourceUrl: artifact.sourceUrl ?? artifact.source?.repositoryUrl ?? null,
      sourceStatus: artifact.sourceStatus ?? null,
      forgeVersion: artifact.forgeVersion ?? null,
      source: artifact.source ?? null,
      sha256: artifact.sha256 ?? null,
      size: artifact.size ?? null,
    }
  }

  /**
   * Read a source file from the registry's pinned revision.
   *
   * Requires the updated registry (`source.raw_base_url` + `commit_sha`). Files
   * are cached per commit under runtime/sources/; pass refresh to bypass.
   */
  async nodeSource(artifactId: string, file = 'README.md', refresh = false): Promise<Record<string, unknown>> {
    const artifact = await this.registry.node(artifactId)
    const source = artifact.source
    if (source?.rawBaseUrl === undefined || source.rawBaseUrl.length === 0) {
      throw new ForgeError('FORGE_SOURCE_UNAVAILABLE', `registry has no pinned source for ${artifactId}`)
    }
    const base = new URL(source.rawBaseUrl)
    if (base.protocol !== 'https:' || !SOURCE_HOSTS.has(base.hostname)) {
      throw new ForgeError('FORGE_SOURCE_UNAVAILABLE', `refusing to fetch from ${base.hostname}`)
    }
    const relative = normalizeSourcePath(file)
    const prefix = source.path === undefined || source.path === '.' || source.path === './' ? '' : `${source.path.replace(/^\/+|\/+$/g, '')}/`
    const url = new URL(`${base.pathname}${prefix}${relative}`.replace(/\/{2,}/g, '/'), base.origin).toString()

    const revision = source.commitSha ?? source.ref ?? 'unknown'
    const cachePath = join(this.paths.runtime, 'sources', artifactId, revision, relative)
    if (!refresh) {
      const cached = await readFile(cachePath, 'utf8').catch(() => undefined)
      if (cached !== undefined) {
        return { artifactId, file: relative, url, ref: source.ref ?? null, commitSha: source.commitSha ?? null, repositoryUrl: source.repositoryUrl ?? null, cached: true, content: cached }
      }
    }
    let response: Response
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(20000), headers: { accept: 'text/plain' } })
    } catch (error) {
      throw new ForgeError('FORGE_REGISTRY_UNAVAILABLE', `${url}: ${(error as Error).message}`)
    }
    if (!response.ok) throw new ForgeError('FORGE_REGISTRY_UNAVAILABLE', `${url}: HTTP ${response.status}`)
    const content = await response.text()
    await mkdir(join(cachePath, '..'), { recursive: true })
    await writeFile(cachePath, content)
    void this.events.append('node.source', { artifactId, file: relative, ref: source.ref ?? null, commit: source.commitSha ?? null })
    return { artifactId, file: relative, url, ref: source.ref ?? null, commitSha: source.commitSha ?? null, repositoryUrl: source.repositoryUrl ?? null, cached: false, content }
  }

  async doctor(name: string, profile?: string): Promise<Diagnosis> {
    await this.ready()
    const diagnosis = await diagnoseSkill({ catalog: this.catalog, runtime: this.runtime, skill: name, profile })
    void this.events.append('doctor.run', { skill: name, ok: diagnosis.ok })
    return diagnosis
  }

  async doctorReport(name?: string): Promise<{ path: string; summary: { skills: number; failing: number; diagnostics: number } }> {
    await this.ready()
    const listing = await this.catalog.list()
    const names = name === undefined ? listing.skills.map(skill => skill.name) : [name]
    const skills = []
    for (const skill of names) {
      skills.push(await diagnoseSkill({ catalog: this.catalog, runtime: this.runtime, skill }))
    }
    const runtimes = []
    for (const skill of names) runtimes.push({ name: skill, runtime: (await this.runtime.status(skill)) ?? null })
    const report = {
      generatedAt: new Date().toISOString(),
      home: this.paths.home,
      skillsRoot: this.paths.skills,
      nodesRoot: this.paths.nodes,
      registry: this.registry.baseUrl,
      skills,
      diagnostics: listing.diagnostics,
      runtimes,
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const path = join(this.paths.runtime, 'reports', `doctor-${stamp}.json`)
    await mkdir(join(this.paths.runtime, 'reports'), { recursive: true })
    await writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 })
    void this.events.append('doctor.report', { path, skills: skills.length })
    return {
      path,
      summary: {
        skills: skills.length,
        failing: skills.filter(skill => !skill.ok).length,
        diagnostics: listing.diagnostics.length,
      },
    }
  }

  // ---- runtime -----------------------------------------------------------

  async runtimeStart(name: string, profile: string, launch: 'start' | 'run' = 'start'): Promise<RuntimeState> {
    await this.ready()
    const state = await withLock(this.lockPath(), () => this.runtime.start(name, profile, { launch }))
    void this.events.append('runtime.start', { skill: name, profile, flow: state.flow, launch })
    return state
  }

  async runtimeStatus(name: string): Promise<RuntimeState | null> {
    await this.ready()
    return (await this.runtime.status(name)) ?? null
  }

  async runtimeStop(name: string, force = false): Promise<RuntimeState | null> {
    await this.ready()
    const state = await withLock(this.lockPath(), () => this.runtime.stop(name, force))
    void this.events.append('runtime.stop', { skill: name, force })
    return state ?? null
  }

  async runtimeLogs(name: string, lines = 120): Promise<string> {
    await this.ready()
    return this.runtime.logs(name, lines)
  }

  // ---- gateway -----------------------------------------------------------

  private async clientFor(name: string): Promise<ForgeToolClient> {
    const state = await this.runtimeStatus(name)
    if (state === null || state.status !== 'healthy') {
      throw new ForgeError('FORGE_RUNTIME_STALE', `skill "${name}" has no healthy runtime`)
    }
    return new ForgeToolClient(state.gatewayUrl, this.callTimeoutMs)
  }

  /** ToolSpecs exposed by the running gateway (used for dynamic registration). */
  async gatewayTools(name: string): Promise<Awaited<ReturnType<ForgeToolClient['tools']>>> {
    return (await this.clientFor(name)).tools()
  }

  async toolContext(name: string, toolId: string): Promise<unknown> {
    return (await this.clientFor(name)).context(toolId)
  }

  async toolCall(name: string, toolId: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const client = await this.clientFor(name)
    const result = await client.invoke(toolId, args)
    void this.events.append('tool.call', { skill: name, tool: toolId, httpStatus: result.httpStatus, invocationId: result.invocationId ?? null })
    const payload = (result.data ?? {}) as Record<string, unknown>
    const inner = (payload['data'] ?? payload) as Record<string, unknown>
    const outputs = ((inner['response'] as Record<string, unknown> | undefined)?.['result'] as Record<string, unknown> | undefined)?.['outputs'] ?? null
    return { ok: result.ok, httpStatus: result.httpStatus, invocationId: result.invocationId ?? null, outputs, data: result.data }
  }

  async invocationRead(name: string, invocationId: string): Promise<Record<string, unknown>> {
    const client = await this.clientFor(name)
    const [status, result] = await Promise.all([client.invocation(invocationId), client.result(invocationId)])
    return { status, result }
  }

  // ---- skill profile files ----------------------------------------------

  /** Every editable profile file of every installed skill. */
  profileTree(): Promise<SkillTree[]> {
    return this.files.tree()
  }

  /** Validate a bundle directory before installing it (local development). */
  validateLocalBundle(path: string): Promise<BundleValidation> {
    return validateBundle(path)
  }

  /** Bundle documentation shipped with a skill (docs/ plus SKILL.md and skill.yaml). */
  async skillDocs(name: string): Promise<Record<string, unknown>> {
    const entry = await this.find(name)
    if (entry === undefined) throw new ForgeError('FORGE_SKILL_NOT_FOUND', `skill "${name}" is not installed`)
    return { skill: name, files: await this.files.bundleDocs(name) }
  }

  async readSkillDoc(name: string, file: string): Promise<Record<string, unknown>> {
    return { skill: name, file, content: await this.files.readBundleDoc(name, file) }
  }

  /** Read one profile file with a parsed summary. */
  async profileRead(name: string, profile: string, file: string): Promise<Record<string, unknown>> {
    const content = await this.files.read(name, profile, file)
    const parsed = parseStructured(file, content)
    return {
      skill: name,
      profile,
      file,
      content,
      valid: parsed.ok,
      ...(parsed.ok ? {} : { error: parsed.error }),
    }
  }

  /** Write one profile file after validation, returning the field-level diff. */
  async profileWrite(name: string, profile: string, file: string, content: string): Promise<Record<string, unknown>> {
    const before = await this.files.read(name, profile, file)
    const parsed = parseStructured(file, content)
    if (!parsed.ok) {
      throw new ForgeError('FORGE_FILE_INVALID', `${file}: ${parsed.error}`)
    }
    const previous = parseStructured(file, before)
    const beforeValue = previous.ok ? previous.value : undefined
    const afterValue = parsed.ok ? parsed.value : undefined
    const diff = beforeValue === undefined || afterValue === undefined ? [] : diffValues(beforeValue, afterValue)
    const written = await withLock(this.lockPath(), () => this.files.write(name, profile, file, content))
    this.changed()
    void this.events.append('profile.write', { skill: name, profile, file, changed: diff.length })
    return {
      skill: name,
      profile,
      file,
      path: written.path,
      backup: written.backup,
      changed: diff.length,
      diff,
      restartRequired: true,
      note: 'restart the skill runtime for this change to take effect',
    }
  }

  // ---- cache / export ----------------------------------------------------

  cacheSummary(): Promise<{ artifacts: Array<{ id: string; bytes: number }>; totalBytes: number }> {
    return this.runtime.nodes.summary()
  }

  async cacheGc(dryRun = false): Promise<{ removed: string[]; freedBytes: number; kept: string[]; referenced: string[] }> {
    const referenced = new Set<string>()
    for (const catalog of this.catalogs) {
      for (const skill of (await catalog.list()).skills) {
        for (const artifact of Object.values(skill.manifest.artifacts)) referenced.add(artifact.artifactId)
      }
    }
    const result = await withLock(this.lockPath(), () => this.runtime.nodes.gc(referenced, dryRun))
    return { ...result, referenced: [...referenced].sort() }
  }

  async exportPortable(name: string, outDir: string): Promise<PortableExport> {
    const found = await this.find(name)
    if (found === undefined) throw new ForgeError('FORGE_SKILL_NOT_FOUND', `skill "${name}" is not installed`)
    const result = await exportPortableSkill(found.entry, outDir)
    void this.events.append('skill.export', { name, path: result.path })
    return result
  }

  /** Every artifact id referenced by installed skills (used by tests and GC). */
  async referencedArtifacts(): Promise<string[]> {
    const ids = new Set<string>()
    for (const catalog of this.catalogs) {
      for (const skill of (await catalog.list()).skills) {
        for (const artifact of Object.values(skill.manifest.artifacts)) ids.add(artifact.artifactId)
      }
    }
    return [...ids].sort()
  }

  /** Read the manifest of one installed skill (used by diagnostics). */
  async manifest(name: string): Promise<ForgeManifest> {
    const found = await this.find(name)
    if (found === undefined) throw new ForgeError('FORGE_SKILL_NOT_FOUND', `skill "${name}" is not installed`)
    return found.entry.manifest
  }

  /** List the installed skill directories (used by diagnostics and exports). */
  async installedDirs(): Promise<string[]> {
    const listing = await this.catalog.list()
    return listing.skills.map(skill => skill.dir)
  }

  /** Count installed skills without touching the registry. */
  async installedCount(): Promise<number> {
    const dirs = await readdir(this.paths.skills).catch(() => [])
    return dirs.filter(name => !name.startsWith('.')).length
  }

  /** Size of a path in bytes (best effort, used by reports). */
  async sizeOf(path: string): Promise<number> {
    try {
      const info = await stat(path)
      return info.size
    } catch {
      return 0
    }
  }
}


function parseStructured(file: string, content: string): { ok: true; value?: unknown } | { ok: false; error: string } {
  try {
    if (/\.ya?ml$/i.test(file)) return { ok: true, value: parseYaml(content) }
    if (/\.json$/i.test(file)) return { ok: true, value: JSON.parse(content) }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: (error as Error).message }
  }
}


const SOURCE_HOSTS = new Set(['raw.githubusercontent.com', 'github.com'])

function normalizeSourcePath(file: string): string {
  const cleaned = file.trim().replace(/^\/+/, '')
  if (cleaned.length === 0 || cleaned.split('/').some(segment => segment === '..' || segment === '.')) {
    throw new ForgeError('FORGE_FILE_INVALID', `invalid source file "${file}"`)
  }
  return cleaned
}
