import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readFileSync, symlinkSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { parseDocument } from 'yaml'

import { ForgeCatalog, type ForgeCheck, type ForgeSkillEntry } from './catalog.js'
import { ForgeError } from './errors.js'
import {
  DEFAULT_FORGE_VERSION,
  forgeGenerationLabel,
  isForgeGeneration,
  unsupportedForgeVersionDetail,
} from './forge-version.js'
import { modelsForProfile, type ForgeProfile } from './manifest.js'
import { ModelStore } from './models.js'
import { forgePaths, type ForgePaths } from './paths.js'
import { NodeStore } from './nodes.js'
import type { ForgeRegistryClient } from './registry.js'

const execFileAsync = promisify(execFile)

/** Lifecycle status persisted for one skill. */
export interface RuntimeState {
  readonly skill: string
  readonly profile: string
  readonly flow: string
  readonly envDir: string
  readonly gatewayUrl: string
  readonly startedAt: string
  readonly version: string
  readonly artifactIds: readonly string[]
  /** dora CLI used to launch this flow (kept so stop/reconcile use the same generation). */
  readonly dora?: string
  /** Forge generation the flow was launched for. */
  readonly forgeVersion?: string
  /** Launch mode: coordinator `start` or isolated `run`. */
  readonly launch?: 'start' | 'run'
  /** Process id of `dora run` for Forge 2 (process-owned, no coordinator). */
  pid?: number
  status: 'starting' | 'healthy' | 'failed' | 'stopped'
  error?: string
}

/** One runtime-level check. */
export type RuntimeCheck = ForgeCheck

export interface PreflightResult {
  readonly ok: boolean
  readonly checks: readonly RuntimeCheck[]
  readonly binaries: Readonly<Record<string, string>>
  readonly modelEnv?: Readonly<Record<string, string>>
}

export interface RuntimeManagerOptions {
  readonly home: string
  /** Optional override for the shared models root; defaults to `<home>/models`. */
  readonly modelsRoot?: string | undefined
  readonly catalog: ForgeCatalog
  readonly registry: ForgeRegistryClient
  /** Forge 1 dora CLI (default 0.4.1): path or command name. */
  readonly dora?: string | undefined
  /** Forge 2 dora CLI (default 1.0.1): path or command name. */
  readonly dora1?: string | undefined
  readonly startTimeoutMs?: number
  readonly pollIntervalMs?: number
}

/**
 * Owns Skill Runtime: resolve node artifacts, materialize an environment,
 * launch one Dora dataflow per skill and stop it again.
 */
export class SkillRuntimeManager {
  readonly paths: ForgePaths
  readonly nodes: NodeStore
  readonly models: ModelStore
  private readonly options: RuntimeManagerOptions
  private readonly states = new Map<string, RuntimeState>()

  /** `<home>/support/bin/dora` (Forge 1) and `dora1` (Forge 2) are the convention. */
  private readonly localDora: string
  private readonly localDora1: string

  constructor(options: RuntimeManagerOptions) {
    this.options = options
    this.paths = forgePaths(options.home, options.modelsRoot)
    this.nodes = new NodeStore(this.paths.nodes, options.registry, join(this.paths.runtime, 'cache'))
    this.models = new ModelStore(this.paths.models)
    const supportBin = join(this.paths.home, 'support', 'bin')
    const localDora = join(supportBin, 'dora')
    const localDora1 = join(supportBin, 'dora1')
    this.localDora = existsSync(localDora) ? localDora : 'dora'
    this.localDora1 = existsSync(localDora1) ? localDora1 : 'dora1'
  }

  /** Forge 1 CLI (dora 0.4.1 by default). */
  private get dora(): string {
    return this.options.dora ?? process.env['DSH_FORGE_DORA'] ?? this.localDora
  }

  /** Forge 2 CLI (dora 1.0.1 by default). */
  private get dora1(): string {
    return this.options.dora1 ?? process.env['DSH_FORGE_DORA1'] ?? this.localDora1
  }

  /** Pick the CLI by the bundle's declared Forge generation. */
  private doraFor(forgeVersion: string | undefined): string {
    return (forgeVersion ?? DEFAULT_FORGE_VERSION) === '2' ? this.dora1 : this.dora
  }

  /** Load persisted state from disk (best effort). */
  async load(): Promise<void> {
    try {
      const text = await readFile(join(this.paths.runtime, 'state.json'), 'utf8')
      const parsed = JSON.parse(text) as { skills?: Record<string, RuntimeState> }
      for (const [skill, state] of Object.entries(parsed.skills ?? {})) this.states.set(skill, state)
      await this.reconcile()
    } catch {
      // no state yet
    }
  }

  /** Drop states whose Dora flow is no longer running (host restart, crash). */
  async reconcile(): Promise<void> {
    const runningByDora = new Map<string, Set<string>>()
    const runningOf = async (dora: string): Promise<Set<string> | undefined> => {
      const cached = runningByDora.get(dora)
      if (cached !== undefined) return cached
      try {
        const { stdout } = await execFileAsync(dora, ['list'], { timeout: 8000 })
        const names = new Set(stdout.split('\n').slice(1).map(line => line.split(/\s{2,}/)[1]).filter((name): name is string => typeof name === 'string' && name.length > 0))
        runningByDora.set(dora, names)
        return names
      } catch {
        runningByDora.set(dora, new Set())
        return undefined
      }
    }
    let changed = false
    for (const state of this.states.values()) {
      if (state.status === 'stopped') continue
      if (state.launch === 'run' || state.pid !== undefined) {
        if (state.pid !== undefined && isAlive(state.pid)) continue
        await killByFlow(state.flow).catch(() => 0)
        state.status = 'stopped'
        delete state.pid
        changed = true
        continue
      }
      const dora = state.dora ?? this.dora
      if ((await runningOf(dora)) === undefined) continue
      if (!(runningByDora.get(dora) as Set<string>).has(state.flow)) {
        await killByFlow(state.flow).catch(() => 0)
        state.status = 'stopped'
        changed = true
      }
    }
    if (changed) await this.persist()
  }

  async status(skill: string): Promise<RuntimeState | undefined> {
    return this.states.get(skill)
  }

  async stopAll(): Promise<void> {
    for (const skill of [...this.states.keys()]) {
      const state = this.states.get(skill)
      if (state === undefined || state.status === 'stopped') continue
      await this.stop(skill).catch(() => undefined)
    }
  }

  /** Static dependency resolution: dora, binaries, assets, environment, port. */
  async preflight(entry: ForgeSkillEntry, profileId: string): Promise<PreflightResult> {
    const checks: RuntimeCheck[] = []
    const forgeVersion = entry.manifest.forgeVersion ?? DEFAULT_FORGE_VERSION
    const dora = this.doraFor(forgeVersion)
    checks.push({
      id: 'forge_version',
      status: isForgeGeneration(forgeVersion) ? 'pass' : 'fail',
      detail: isForgeGeneration(forgeVersion)
        ? `${forgeGenerationLabel(forgeVersion)} via ${dora}`
        : unsupportedForgeVersionDetail(forgeVersion),
    })
    const profile = entry.manifest.profiles[profileId]
    if (profile === undefined) {
      return { ok: false, checks: [{ id: 'profile', status: 'fail', detail: `unknown profile "${profileId}"` }], binaries: {} }
    }

    try {
      const { stdout } = await execFileAsync(dora, ['--version'], { timeout: 5000 })
      checks.push({ id: 'dora', status: 'pass', detail: `${stdout.trim().split('\n')[0] ?? 'dora'} (${dora})` })
    } catch (error) {
      checks.push({ id: 'dora', status: 'fail', detail: `dora not runnable: ${(error as Error).message}` })
    }

    const binaries: Record<string, string> = {}
    for (const binary of profile.requiredBinaries) {
      const lock = entry.manifest.artifacts[binary]
      if (lock === undefined) {
        checks.push({ id: `binary.${binary}`, status: 'fail', detail: 'no artifact lock' })
        continue
      }
      if (lock.platform !== process.platform || lock.arch !== archName()) {
        checks.push({ id: `binary.${binary}`, status: 'fail', detail: `lock is ${lock.platform}/${lock.arch}, host is ${process.platform}/${archName()}` })
        continue
      }
      const status = await this.nodes.inspect(lock, binary)
      if (status.state === 'ready') {
        binaries[binary] = status.entrypoint
        checks.push({ id: `binary.${binary}`, status: 'pass', detail: status.detail })
      } else if (status.state === 'unverified') {
        binaries[binary] = status.entrypoint
        checks.push({ id: `binary.${binary}`, status: 'warn', detail: status.detail })
      } else {
        checks.push({ id: `binary.${binary}`, status: 'fail', detail: `${status.detail} (install nodes for this skill)` })
      }
    }

    for (const asset of profile.requiredAssets) {
      const path = join(entry.dir, asset)
      checks.push(await existsCheck(`asset.${asset}`, path))
    }

    const modelEnv: Record<string, string> = {}
    for (const req of modelsForProfile(entry.manifest, profileId)) {
      const status = await this.models.resolveRequirement(req)
      if (status.path !== undefined && req.env !== undefined && status.state !== 'missing' && status.state !== 'mismatch') {
        modelEnv[req.env] = status.path
      }
      if (status.state === 'ready') {
        checks.push({ id: `model.${req.id}`, status: 'pass', detail: status.detail })
      } else if (status.state === 'unverified') {
        checks.push({ id: `model.${req.id}`, status: 'warn', detail: status.detail })
      } else {
        checks.push({
          id: `model.${req.id}`,
          status: status.optional ? 'warn' : 'fail',
          detail: status.detail,
        })
      }
    }

    const missingEnv = profile.requiredEnvironment.filter(
      name => (process.env[name] ?? profile.environment[name] ?? modelEnv[name]) === undefined,
    )
    checks.push({
      id: 'environment',
      status: missingEnv.length === 0 ? 'pass' : 'fail',
      detail: missingEnv.length === 0 ? 'all required variables present' : `missing: ${missingEnv.join(', ')}`,
    })

    const gateway = entry.manifest.gatewayUrl
    if (gateway === undefined) {
      checks.push({ id: 'gateway_url', status: 'fail', detail: 'manifest has no gateway_url' })
    } else {
      const busy = await portBusy(gateway)
      const own = [...this.states.values()].some(state => state.gatewayUrl === gateway && state.status !== 'stopped')
      checks.push({
        id: 'gateway_url',
        status: busy && !own ? 'fail' : 'pass',
        detail: busy ? (own ? `${gateway} held by this manager` : `${gateway} is already in use`) : `${gateway} is free`,
      })
    }

    return { ok: checks.every(check => check.status !== 'fail'), checks, binaries, modelEnv }
  }

  /** Start one skill/profile pair and wait for the gateway to be healthy. */
  async start(skill: string, profileId: string, options: { launch?: 'start' | 'run' } = {}): Promise<RuntimeState> {
    const entry = await this.options.catalog.load(skill)
    if (entry === undefined) throw new ForgeError('FORGE_SKILL_NOT_FOUND', `skill "${skill}" is not installed`)
    const profile = entry.manifest.profiles[profileId]
    if (profile === undefined) throw new ForgeError('FORGE_PROFILE_UNKNOWN', `profile "${profileId}" does not exist`)
    if (entry.manifest.gatewayUrl === undefined) throw new ForgeError('FORGE_MANIFEST_INVALID', 'manifest has no gateway_url')

    const existing = this.states.get(skill)
    if (existing !== undefined && existing.status !== 'stopped' && existing.status !== 'failed') {
      if (existing.profile === profileId && existing.status === 'healthy') return existing
      throw new ForgeError('FORGE_RUNTIME_STALE', `skill "${skill}" already has an active runtime (${existing.profile}); stop it first`)
    }

    const preflight = await this.preflight(entry, profileId)
    if (!preflight.ok) {
      const failed = preflight.checks.filter(check => check.status === 'fail')
      throw new ForgeError('FORGE_NODE_MISSING', failed.map(check => `${check.id}: ${check.detail}`).join('; '))
    }

    const requiredArtifacts = profile.requiredBinaries
      .map(binary => entry.manifest.artifacts[binary]?.artifactId)
      .filter((artifactId): artifactId is string => artifactId !== undefined)
    const nodePlan = await this.nodes.ensureManifest(entry.manifest, requiredArtifacts)
    const binaries: Record<string, string> = { ...preflight.binaries }
    for (const binary of profile.requiredBinaries) {
      const lock = entry.manifest.artifacts[binary]
      if (lock === undefined) continue
      const status = await this.nodes.inspect(lock, binary)
      if (status.state === 'ready' || status.state === 'unverified') binaries[binary] = status.entrypoint
    }

    const forgeVersion = entry.manifest.forgeVersion ?? '1'
    const dora = this.doraFor(forgeVersion)
    const launch = options.launch ?? 'start'
    const flow = `forge-${slug(skill)}-${slug(profileId)}-${Date.now().toString(36)}`
    const modelEnv = preflight.modelEnv ?? {}
    // Materialize for both launch modes: Forge 1 dataflows reference ${FORGE_RUNTIME_BIN}.
    const envDir = await this.materialize(entry, profile, binaries, flow, modelEnv)
    const gatewayUrl = entry.manifest.gatewayUrl
    const state: RuntimeState = {
      skill,
      profile: profileId,
      flow,
      envDir,
      gatewayUrl,
      startedAt: new Date().toISOString(),
      version: entry.manifest.version,
      artifactIds: Object.values(entry.manifest.artifacts).map(artifact => artifact.artifactId),
      dora,
      forgeVersion,
      launch,
      status: 'starting',
    }
    this.states.set(skill, state)
    await this.persist()

    try {
      if (launch === 'run') {
        state.pid = await this.spawnRun(dora, entry, profile, flow, envDir, modelEnv)
      } else {
        await this.ensureCoordinator(dora, envDir)
        await execFileAsync(dora, [
          'start', join(envDir, 'launch', profile.dataflow), '--name', flow, '--detach',
        ], { cwd: join(envDir, 'launch', dirname(profile.dataflow)), env: this.flowEnv(entry, profile, envDir, modelEnv), timeout: 60000 })
      }

      await this.waitForGateway(gatewayUrl)
      state.status = 'healthy'
      await this.persist()
      return state
    } catch (error) {
      if (state.pid !== undefined) await killProcessTree(state.pid).catch(() => undefined)
      await killByFlow(state.flow).catch(() => 0)
      state.status = 'failed'
      state.error = (error as Error).message
      await this.persist()
      throw error
    }
  }

  /** Launch a flow with `dora run`: no coordinator, process-owned. */
  private async spawnRun(
    dora: string,
    entry: ForgeSkillEntry,
    profile: ForgeProfile,
    flow: string,
    envDir: string,
    modelEnv: Readonly<Record<string, string>> = {},
  ): Promise<number> {
    const dataflow = join(envDir, 'launch', profile.dataflow)
    await mkdir(this.paths.logs, { recursive: true })
    const logPath = join(this.paths.logs, `${flow}.log`)
    const fd = openSync(logPath, 'a')
    try {
      const child = spawn(dora, ['run', dataflow], {
        cwd: dirname(dataflow),
        env: this.flowEnv(entry, profile, envDir, modelEnv),
        detached: true,
        stdio: ['ignore', fd, fd],
      })
      child.unref()
      if (child.pid === undefined) throw new ForgeError('FORGE_DORA_MISSING', `failed to spawn ${dora} run`)
      return child.pid
    } finally {
      closeSync(fd)
    }
  }

  /** Stop the runtime of one skill. */
  async stop(skill: string, force = false): Promise<RuntimeState | undefined> {
    const state = this.states.get(skill)
    if (state === undefined) return undefined
    if (state.status === 'stopped') return state
    if (state.status === 'failed' && state.pid === undefined) {
      state.status = 'stopped'
      delete state.error
      await this.persist()
      return state
    }
    if (state.launch === 'run' || state.pid !== undefined) {
      if (state.pid !== undefined) await killProcessTree(state.pid, force)
      await killByFlow(state.flow, force).catch(() => 0)
      state.status = 'stopped'
      delete state.pid
      delete state.error
      await this.persist()
      return state
    }
    const args = ['stop', '--name', state.flow]
    if (force) args.push('--force')
    let stopError: string | undefined
    try {
      await execFileAsync(state.dora ?? this.dora, args, { timeout: 30000 })
    } catch (error) {
      stopError = (error as Error).message
    }
    // A failed flow can leave orphan nodes behind; kill anything still carrying the flow marker.
    const orphans = await killByFlow(state.flow, force).catch(() => 0)
    const leftover = (await pidsForFlow(state.flow).catch(() => [])).length
    if (leftover > 0) {
      state.status = 'failed'
      state.error = `dora stop failed and ${leftover} node process(es) remain: ${stopError ?? 'unknown error'}`
      await this.persist()
      throw new ForgeError('FORGE_RUNTIME_STALE', state.error)
    }
    state.status = 'stopped'
    delete state.error
    await this.persist()
    return state
  }

  /** Tail a runtime log file. */
  async logs(skill: string, lines = 120): Promise<string> {
    const state = this.states.get(skill)
    if (state === undefined) return ''
    try {
      const files = await readdir(this.paths.logs)
      const relevant = files.filter(name => name.startsWith(`${state.flow}`)).sort()
      const chunks: string[] = []
      for (const file of relevant) {
        const text = await readFile(join(this.paths.logs, file), 'utf8').catch(() => '')
        chunks.push(text.split('\n').slice(-lines).join('\n'))
      }
      return chunks.join('\n').trim()
    } catch {
      return ''
    }
  }

  private async materialize(
    entry: ForgeSkillEntry,
    profile: ForgeProfile,
    binaries: Readonly<Record<string, string>>,
    flow: string,
    modelEnv: Readonly<Record<string, string>> = {},
  ): Promise<string> {
    const hash = createHash('sha256')
      .update(entry.manifest.version)
      .update(profile.id)
      .update(readFileSync(join(entry.dir, profile.dataflow)))
      .digest('hex')
      .slice(0, 16)
    const envDir = join(this.paths.runtime, 'env', entry.name, profile.id, hash)
    await rm(envDir, { recursive: true, force: true })
    await mkdir(join(envDir, 'bin'), { recursive: true })
    for (const [binary, path] of Object.entries(binaries)) {
      symlinkSync(path, join(envDir, 'bin', binary))
    }
    const launch = join(envDir, 'launch')
    await cp(entry.dir, launch, {
      recursive: true,
      filter: source => !/node_modules|\.git|(^|\/)nodes(\/|$)/.test(source),
    })
    await rewritePlaceholders(launch, '${FORGE_RUNTIME_BIN}', join(envDir, 'bin'))
    await rewritePlaceholders(launch, '${FORGE_MODELS_DIR}', this.paths.models)
    // Dora renders neither PAOS_SKILL_* nor FORGE_FLOW_ID in node paths, so the
    // materialized tree carries the same values the flow environment does.
    await rewritePlaceholders(launch, '${PAOS_SKILL_ROOT}', entry.dir)
    await rewritePlaceholders(launch, '${PAOS_SKILL_NAME}', entry.name)
    await rewritePlaceholders(launch, '${PAOS_SKILL_VERSION}', entry.manifest.version)
    await rewritePlaceholders(launch, '${PAOS_RUNTIME_INSTANCE_ID}', basename(envDir))
    await rewritePlaceholders(launch, '${FORGE_FLOW_ID}', flow)
    await injectDataflowEnv(join(launch, profile.dataflow), {
      ...modelEnv,
      ...profile.environment,
      ...Object.fromEntries(profile.requiredEnvironment
        .filter(name => profile.environment[name] === undefined && process.env[name] !== undefined)
        .map(name => [name, process.env[name] as string])),
      FORGE_RUNTIME_BIN: join(envDir, 'bin'),
      FORGE_MODELS_DIR: this.paths.models,
      PAOS_SKILL_ROOT: entry.dir,
      PAOS_SKILL_NAME: entry.name,
      PAOS_SKILL_VERSION: entry.manifest.version,
      PAOS_RUNTIME_INSTANCE_ID: basename(envDir),
      FORGE_FLOW_ID: flow,
    })
    await writeFile(join(envDir, 'runtime-lock.json'), JSON.stringify({
      skill: entry.name,
      version: entry.manifest.version,
      profile: profile.id,
      binaries,
      modelsRoot: this.paths.models,
      modelEnv,
      artifacts: Object.fromEntries(Object.entries(entry.manifest.artifacts).map(([key, value]) => [key, value.artifactId])),
    }, null, 2))
    await mkdir(this.paths.logs, { recursive: true })
    return envDir
  }

  private flowEnv(
    entry: ForgeSkillEntry,
    profile: ForgeProfile,
    envDir: string,
    modelEnv: Readonly<Record<string, string>> = {},
  ): NodeJS.ProcessEnv {
    return {
      ...modelEnv,
      ...process.env,
      ...profile.environment,
      FORGE_RUNTIME_BIN: join(envDir, 'bin'),
      FORGE_MODELS_DIR: this.paths.models,
      PAOS_SKILL_ROOT: entry.dir,
      PAOS_SKILL_NAME: entry.name,
      PAOS_SKILL_VERSION: entry.manifest.version,
      PAOS_RUNTIME_INSTANCE_ID: basename(envDir),
    }
  }

  private async ensureCoordinator(dora: string, envDir: string): Promise<void> {
    if (await coordinatorReady(dora)) return
    await mkdir(this.paths.logs, { recursive: true })
    const fd = openSync(join(this.paths.logs, 'dora-coordinator.log'), 'a')
    try {
      const child = spawn(dora, ['up'], { cwd: envDir, detached: true, stdio: ['ignore', fd, fd] })
      child.unref()
    } finally {
      closeSync(fd)
    }
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      if (await coordinatorReady(dora)) return
      await new Promise(resolveWait => setTimeout(resolveWait, 250))
    }
    throw new ForgeError('FORGE_DORA_MISSING', 'dora coordinator did not become ready')
  }

  private async waitForGateway(gatewayUrl: string): Promise<void> {
    const deadline = Date.now() + (this.options.startTimeoutMs ?? 120000)
    const interval = this.options.pollIntervalMs ?? 500
    let last = 'no response'
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${gatewayUrl.replace(/\/+$/, '')}/tools`, { signal: AbortSignal.timeout(2000) })
        if (response.ok) return
        last = `HTTP ${response.status}`
      } catch (error) {
        last = (error as Error).message
      }
      await new Promise(resolveWait => setTimeout(resolveWait, interval))
    }
    throw new ForgeError('FORGE_GATEWAY_UNREACHABLE', `${gatewayUrl}/tools not ready: ${last}`)
  }

  private async persist(): Promise<void> {
    await mkdir(this.paths.runtime, { recursive: true })
    const payload = { skills: Object.fromEntries(this.states) }
    const target = join(this.paths.runtime, 'state.json')
    const temp = `${target}.tmp`
    await writeFile(temp, JSON.stringify(payload, null, 2))
    const { rename } = await import('node:fs/promises')
    await rename(temp, target)
  }
}

async function rewritePlaceholders(root: string, needle: string, value: string): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      await rewritePlaceholders(path, needle, value)
      continue
    }
    if (!/\.(ya?ml|json|sh|txt|toml)$/.test(entry.name)) continue
    const text = await readFile(path, 'utf8')
    if (!text.includes(needle)) continue
    await writeFile(path, text.split(needle).join(value))
  }
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && (info.mode & 0o111) !== 0
  } catch {
    return false
  }
}

async function existsCheck(id: string, path: string): Promise<RuntimeCheck> {
  try {
    const info = await stat(path)
    return { id, status: info.isFile() ? 'pass' : 'warn', detail: path }
  } catch {
    return { id, status: 'fail', detail: `${path} is missing` }
  }
}

async function portBusy(url: string): Promise<boolean> {
  try {
    const parsed = new URL(url)
    const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
    const { connect } = await import('node:net')
    return await new Promise<boolean>(resolvePort => {
      const socket = connect({ host: parsed.hostname, port })
      socket.setTimeout(500)
      socket.once('connect', () => { socket.destroy(); resolvePort(true) })
      socket.once('timeout', () => { socket.destroy(); resolvePort(false) })
      socket.once('error', () => resolvePort(false))
    })
  } catch {
    return false
  }
}

function archName(): string {
  if (process.arch === 'x64') return 'x86_64'
  if (process.arch === 'arm64') return 'aarch64'
  if (process.arch === 'ia32') return 'x86'
  return process.arch
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, '-')
}

// Keep `relative`/`isAbsolute` referenced for future path checks without emitting noise.
void relative
void isAbsolute


/**
 * Terminate a detached `dora run` and every process it spawned.
 *
 * dora run may put nodes in their own process groups, so signalling only the
 * orchestrator's group leaves node processes (and their ports) alive. Collect
 * the process tree first, try a graceful SIGINT, then escalate.
 */
async function killProcessTree(pid: number, force = false): Promise<void> {
  const signalAll = (signal: NodeJS.Signals, pids: readonly number[]): void => {
    for (const target of pids) {
      try { process.kill(target, signal) } catch { /* already gone */ }
    }
  }
  const signalGroup = (signal: NodeJS.Signals): void => {
    try { process.kill(-pid, signal) } catch {
      try { process.kill(pid, signal) } catch { /* already gone */ }
    }
  }

  let descendants = await listDescendants(pid).catch(() => [] as number[])
  if (!force) {
    signalGroup('SIGINT')
    if (await waitForExit(pid, 2000)) {
      signalAll('SIGKILL', await listDescendants(pid).catch(() => descendants))
      return
    }
  }
  signalAll('SIGTERM', [pid, ...descendants])
  signalGroup('SIGTERM')
  if (!force && await waitForExit(pid, 3000)) {
    signalAll('SIGKILL', await listDescendants(pid).catch(() => descendants))
    return
  }
  const remaining = new Set<number>([pid, ...descendants])
  for (const extra of await listDescendants(pid).catch(() => [] as number[])) remaining.add(extra)
  signalAll('SIGKILL', [...remaining])
  signalGroup('SIGKILL')
}

/** Direct and transitive children of one pid, read once from ps. */
async function listDescendants(root: number): Promise<number[]> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid='], { timeout: 5000 })
  const children = new Map<number, number[]>()
  for (const line of stdout.split('\n')) {
    const [pidText, parentText] = line.trim().split(/\s+/)
    const pid = Number(pidText)
    const parent = Number(parentText)
    if (!Number.isFinite(pid) || !Number.isFinite(parent)) continue
    const list = children.get(parent) ?? []
    list.push(pid)
    children.set(parent, list)
  }
  const result: number[] = []
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift() as number
    for (const child of children.get(current) ?? []) {
      result.push(child)
      queue.push(child)
    }
  }
  return result
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  return !isAlive(pid)
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}


/**
 * Merge deployment environment into the materialized dataflow.
 *
 * Coordinator mode spawns nodes from the daemon, so a CLI environment never
 * reaches them; a dataflow-level `env:` block is the portable way to carry
 * profile.environment and host-provided required variables. Node-level `env:`
 * still wins. The file stays inside runtime/env (never the installed skill).
 */
async function injectDataflowEnv(path: string, env: Readonly<Record<string, string>>): Promise<void> {
  const entries = Object.entries(env).filter(([, value]) => typeof value === 'string' && value.length > 0)
  if (entries.length === 0) return
  const document = parseDocument(await readFile(path, 'utf8'))
  const nodes = document.get('nodes') as { readonly items?: readonly unknown[] } | undefined
  const count = Array.isArray(nodes) ? nodes.length : (nodes?.items?.length ?? 0)
  if (count === 0) return
  // dora 0.4.x rejects a dataflow-level env block; node-level env works in both generations.
  for (let index = 0; index < count; index += 1) {
    for (const [name, value] of entries) {
      document.setIn(['nodes', index, 'env', name], value)
    }
  }
  await writeFile(path, String(document), { mode: 0o600 })
}

/** A coordinator is ready when `dora list` succeeds (works for 0.4.x and 1.x). */
async function coordinatorReady(dora: string): Promise<boolean> {
  try {
    await execFileAsync(dora, ['list'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}


/** pids whose environment carries this flow marker (survives reparenting/double-fork). */
async function pidsForFlow(flow: string): Promise<number[]> {
  const marker = `FORGE_FLOW_ID=${flow}`
  const pids: number[] = []
  let entries: string[] = []
  try {
    entries = await readdir('/proc')
  } catch {
    return pids
  }
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue
    try {
      const environ = await readFile(`/proc/${name}/environ`)
      if (environ.includes(marker)) pids.push(Number(name))
    } catch {
      // process exited or not readable
    }
  }
  return pids
}

async function killByFlow(flow: string, force = false): Promise<number> {
  let pids = await pidsForFlow(flow)
  if (pids.length === 0) return 0
  const signal = (signalName: NodeJS.Signals): void => {
    for (const pid of pids) {
      try { process.kill(pid, signalName) } catch { /* gone */ }
    }
  }
  signal('SIGTERM')
  if (!force) {
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      pids = pids.filter(isAlive)
      if (pids.length === 0) return 0
      await new Promise(resolveWait => setTimeout(resolveWait, 100))
    }
  }
  const remaining = await pidsForFlow(flow)
  for (const pid of remaining) {
    try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
  }
  return remaining.length
}
