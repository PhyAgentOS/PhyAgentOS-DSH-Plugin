import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Minimum Node.js major declared by the plugin `engines` field. */
const MIN_NODE_MAJOR = 22
/** Forge 1 baseline: dora-cli 0.4.x (0.4.1 is the reference release). */
const DORA_REFERENCE_MINOR = '0.4'
/** Forge 2 requires dora-cli >=1.0.1,<2. */
const DORA1_MIN = '1.0.1'
const DORA1_MAX_MAJOR = 2
/** Forge 2 runs Python nodes from source; 3.10 is the floor, 3.12 the reference. */
const MIN_PYTHON = '3.10'
const GIB = 1024 ** 3
/** A single MuJoCo skill plus its node artifacts easily reaches several GiB. */
const DISK_FAIL_BYTES = 1 * GIB
const DISK_WARN_BYTES = 5 * GIB

const REPORT_DIR = 'runtime/reports'

/**
 * Stable codes for one environment check.
 *
 * They follow the same contract as every other `FORGE_*` code: the code is what
 * logs, reports and tests key off, the detail stays human-facing.
 */
export const EnvironmentCode = {
  platformUnsupported: 'FORGE_ENV_PLATFORM_UNSUPPORTED',
  nodeVersion: 'FORGE_ENV_NODE_VERSION',
  doraMissing: 'FORGE_ENV_DORA_MISSING',
  doraVersion: 'FORGE_ENV_DORA_VERSION',
  dora1Missing: 'FORGE_ENV_DORA1_MISSING',
  dora1Version: 'FORGE_ENV_DORA1_VERSION',
  pythonMissing: 'FORGE_ENV_PYTHON_MISSING',
  pythonVersion: 'FORGE_ENV_PYTHON_VERSION',
  homeUnwritable: 'FORGE_ENV_HOME_UNWRITABLE',
  diskLow: 'FORGE_ENV_DISK_LOW',
  registryUnreachable: 'FORGE_ENV_REGISTRY_UNREACHABLE',
  portBusy: 'FORGE_ENV_PORT_BUSY',
  noSkills: 'FORGE_ENV_NO_SKILLS',
  runtimeStateBroken: 'FORGE_ENV_RUNTIME_STATE_BROKEN',
  envMissing: 'FORGE_ENV_ENV_MISSING',
  envStale: 'FORGE_ENV_ENV_STALE',
} as const

export type EnvironmentCodeValue = (typeof EnvironmentCode)[keyof typeof EnvironmentCode]

/** One line of the environment report. */
export interface EnvironmentCheck {
  readonly id: string
  readonly status: 'pass' | 'warn' | 'fail'
  readonly detail: string
  readonly code?: string
  readonly hint?: string
}

/** A skill contributes its declared gateway URL to the port checks. */
export interface EnvironmentSkill {
  readonly name: string
  readonly gatewayUrl?: string | undefined
}

/** One persisted runtime, as recorded in `<home>/runtime/state.json`. */
export interface EnvironmentRuntime {
  readonly skill: string
  readonly status: string
  readonly profile?: string
  readonly flow?: string
  readonly launch?: 'start' | 'run'
  readonly dora?: string
  readonly forgeVersion?: string
  readonly gatewayUrl?: string
  readonly envDir?: string
  readonly startedAt?: string
}

/** One runtime plus what the isolation directory on disk actually holds. */
export interface EnvironmentRuntimeInstance extends EnvironmentRuntime {
  readonly envDirExists: boolean
  /** Summary of `<envDir>/runtime-lock.json`, when readable. */
  readonly lock?: { readonly version?: string; readonly artifacts?: number }
}

/**
 * The isolation contract every flow environment follows.
 *
 * Recorded in the report so a machine can be compared after an upgrade: the
 * template, the variables injected into the materialized dataflow, and the two
 * launch modes.
 */
export interface EnvironmentIsolation {
  readonly envDirTemplate: string
  readonly injected: readonly string[]
  readonly launch: { readonly start: string; readonly run: string }
}

/** The runtime-isolation half of the report. */
export interface EnvironmentRuntimeContext {
  readonly stateFile: string
  readonly envRoot: string
  readonly stateExists: boolean
  readonly instances: readonly EnvironmentRuntimeInstance[]
  /** Every `<skill>/<profile>/<hash>` directory found under the env root. */
  readonly envDirs: number
  /** Env directories no persisted runtime references. */
  readonly orphans: readonly string[]
  readonly isolation: EnvironmentIsolation
}

/** Runs an executable and captures its version output; injectable for tests. */
export type EnvironmentExec = (
  file: string,
  args: readonly string[],
) => Promise<{ stdout: string; stderr?: string }>

export interface EnvironmentCheckOptions {
  /** Forge data root; also the path written to and measured for free space. */
  readonly home: string
  /** Forge 1 dora CLI; defaults to `<home>/support/bin/dora` then `DSH_FORGE_DORA` then `dora`. */
  readonly dora?: string | undefined
  /** Forge 2 dora CLI; defaults to `<home>/support/bin/dora1` then `DSH_FORGE_DORA1` then `dora1`. */
  readonly dora1?: string | undefined
  readonly registryUrl?: string | undefined
  readonly registryTimeoutMs?: number | undefined
  readonly skills?: readonly EnvironmentSkill[] | undefined
  /** Runtime state file; defaults to `<home>/runtime/state.json`. */
  readonly stateFile?: string | undefined
  /** Isolated flow environments root; defaults to `<home>/runtime/env`. */
  readonly envRoot?: string | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  /** Skip the registry probe (air-gapped machines, tests). */
  readonly offline?: boolean | undefined
  /** Write the JSON report under `<home>/runtime/reports`; defaults to true. */
  readonly writeReport?: boolean | undefined
  readonly exec?: EnvironmentExec | undefined
  readonly fetch?: typeof fetch | undefined
}

export interface EnvironmentReport {
  readonly ok: boolean
  readonly generatedAt: string
  readonly home: string
  readonly platform: string
  readonly node: string
  readonly summary: { readonly pass: number; readonly warn: number; readonly fail: number }
  readonly checks: readonly EnvironmentCheck[]
  /** Isolated flow environments and the persisted runtimes that own them. */
  readonly runtime: EnvironmentRuntimeContext
  /** Written report, when `writeReport` is not false. */
  readonly path?: string
}

interface Version {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

interface Probe {
  readonly ok: boolean
  readonly text: string
}

/**
 * Check the base environment once, independent of any installed skill.
 *
 * This is the "install the plugin, then ask whether the machine can actually
 * run Forge" entry point: both Dora generations, Node, Python, the data root
 * (writable + free space), the registry, the gateway ports the installed skills
 * declare, and the `DSH_FORGE_*` variables. Read-only apart from the report and
 * a short-lived write probe; the report keeps the previous one untouched.
 */
export async function checkEnvironment(options: EnvironmentCheckOptions): Promise<EnvironmentReport> {
  const env = options.env ?? process.env
  const exec = options.exec ?? defaultExec
  const checks: EnvironmentCheck[] = []
  const push = (check: EnvironmentCheck): void => {
    checks.push(check)
  }

  // ---- host -------------------------------------------------------------
  const platform = `${process.platform}/${process.arch}`
  if (process.platform === 'linux' && process.arch === 'x64') {
    push({ id: 'platform', status: 'pass', detail: `${platform} (reference platform)` })
  } else {
    push({
      id: 'platform',
      status: 'warn',
      code: EnvironmentCode.platformUnsupported,
      detail: `${platform}; node artifacts are published per platform`,
      hint: 'install only skills whose artifact locks match this host, or rebuild their nodes',
    })
  }

  const nodeVersion = process.versions.node
  const nodeMajor = Number(nodeVersion.split('.')[0])
  if (Number.isFinite(nodeMajor) && nodeMajor >= MIN_NODE_MAJOR) {
    push({ id: 'node', status: 'pass', detail: `v${nodeVersion}` })
  } else {
    push({
      id: 'node',
      status: 'fail',
      code: EnvironmentCode.nodeVersion,
      detail: `v${nodeVersion} is below the supported major ${MIN_NODE_MAJOR}`,
      hint: `upgrade Node.js to ${MIN_NODE_MAJOR} or newer`,
    })
  }

  // ---- dora generations -------------------------------------------------
  const dora = resolveCli(options.dora, env['DSH_FORGE_DORA'], options.home, 'dora')
  const doraProbe = await probe(dora, ['--version'], exec)
  const doraVersion = parseVersion(doraProbe.text)
  if (!doraProbe.ok) {
    push({
      id: 'dora',
      status: 'fail',
      code: EnvironmentCode.doraMissing,
      detail: `${dora}: ${firstLine(doraProbe.text)}`,
      hint: `set runtime.dora (or DSH_FORGE_DORA, or <home>/support/bin/dora) to the Forge 1 dora CLI (0.4.1 baseline)`,
    })
  } else if (doraVersion === undefined) {
    push({
      id: 'dora',
      status: 'warn',
      code: EnvironmentCode.doraVersion,
      detail: `${dora} answered without a version: ${firstLine(doraProbe.text)}`,
      hint: 'expected `dora-cli 0.4.x`',
    })
  } else if (`${doraVersion.major}.${doraVersion.minor}` !== DORA_REFERENCE_MINOR) {
    push({
      id: 'dora',
      status: 'warn',
      code: EnvironmentCode.doraVersion,
      detail: `dora-cli ${formatVersion(doraVersion)} at ${dora}; Forge 1 baseline is ${DORA_REFERENCE_MINOR}.1`,
      hint: 'Forge 1 dataflows are validated against dora 0.4.1; pin runtime.dora to it',
    })
  } else {
    push({ id: 'dora', status: 'pass', detail: `dora-cli ${formatVersion(doraVersion)} (${dora})` })
  }

  const dora1 = resolveCli(options.dora1, env['DSH_FORGE_DORA1'], options.home, 'dora1')
  const dora1Probe = await probe(dora1, ['--version'], exec)
  const dora1Version = parseVersion(dora1Probe.text)
  if (!dora1Probe.ok) {
    push({
      id: 'dora1',
      status: 'fail',
      code: EnvironmentCode.dora1Missing,
      detail: `${dora1}: ${firstLine(dora1Probe.text)}`,
      hint: 'set runtime.dora1 (or DSH_FORGE_DORA1, or <home>/support/bin/dora1) to the Forge 2 dora CLI (>=1.0.1,<2)',
    })
  } else if (dora1Version === undefined) {
    push({
      id: 'dora1',
      status: 'fail',
      code: EnvironmentCode.dora1Version,
      detail: `${dora1} answered without a version: ${firstLine(dora1Probe.text)}`,
      hint: 'expected `dora-cli >=1.0.1,<2`',
    })
  } else if (!atLeast(dora1Version, parseRequired(DORA1_MIN)) || dora1Version.major >= DORA1_MAX_MAJOR) {
    push({
      id: 'dora1',
      status: 'fail',
      code: EnvironmentCode.dora1Version,
      detail: `dora-cli ${formatVersion(dora1Version)} at ${dora1} is outside >=${DORA1_MIN},<${DORA1_MAX_MAJOR}`,
      hint: `install dora-cli ${DORA1_MIN} or newer 1.x and point runtime.dora1 at it`,
    })
  } else {
    push({ id: 'dora1', status: 'pass', detail: `dora-cli ${formatVersion(dora1Version)} (${dora1})` })
  }

  // ---- python -----------------------------------------------------------
  const python = env['DSH_FORGE_PYTHON'] ?? 'python3'
  const pythonProbe = await probe(python, ['--version'], exec)
  const pythonVersion = parseVersion(pythonProbe.text)
  if (!pythonProbe.ok) {
    push({
      id: 'python',
      status: 'warn',
      code: EnvironmentCode.pythonMissing,
      detail: `${python}: ${firstLine(pythonProbe.text)}`,
      hint: 'only Forge 2 source skills need Python; install python3 >= 3.10 to run them',
    })
  } else if (pythonVersion === undefined) {
    push({
      id: 'python',
      status: 'warn',
      code: EnvironmentCode.pythonVersion,
      detail: `${python} answered without a version: ${firstLine(pythonProbe.text)}`,
      hint: `expected Python >= ${MIN_PYTHON}`,
    })
  } else if (!atLeast(pythonVersion, parseRequired(MIN_PYTHON))) {
    push({
      id: 'python',
      status: 'warn',
      code: EnvironmentCode.pythonVersion,
      detail: `Python ${formatVersion(pythonVersion)} is below ${MIN_PYTHON}`,
      hint: `upgrade to Python ${MIN_PYTHON} or newer for Forge 2 source skills`,
    })
  } else {
    push({ id: 'python', status: 'pass', detail: `Python ${formatVersion(pythonVersion)} (${python})` })
  }

  // ---- data root --------------------------------------------------------
  const homeReady = await prepareHome(options.home, push, EnvironmentCode.homeUnwritable)
  if (homeReady) {
    const free = await freeBytes(options.home)
    if (free === undefined) {
      push({ id: 'disk', status: 'warn', detail: 'free space unavailable for the data root' })
    } else {
      const detail = `${(free / GIB).toFixed(1)} GiB free under ${options.home}`
      if (free < DISK_FAIL_BYTES) {
        push({
          id: 'disk',
          status: 'fail',
          code: EnvironmentCode.diskLow,
          detail,
          hint: 'node artifacts and MuJoCo models need multiple GiB; free space or move the data root',
        })
      } else if (free < DISK_WARN_BYTES) {
        push({
          id: 'disk',
          status: 'warn',
          code: EnvironmentCode.diskLow,
          detail,
          hint: 'a single skill install can consume several GiB',
        })
      } else {
        push({ id: 'disk', status: 'pass', detail })
      }
    }
  }

  // ---- variables (values are never printed) -----------------------------
  const variables = [
    'DSH_FORGE_HOME',
    'DSH_FORGE_DORA',
    'DSH_FORGE_DORA1',
    'DSH_FORGE_PYTHON',
    'DSH_FORGE_REGISTRY_URL',
    'DSH_FORGE_REGISTRY_TOKEN',
  ]
  const present = variables.filter(name => (env[name] ?? '').length > 0)
  push({
    id: 'variables',
    status: 'pass',
    detail: present.length === 0 ? 'none set; defaults apply' : `set: ${present.join(', ')}`,
  })

  // ---- registry ---------------------------------------------------------
  push(await checkRegistry({
    offline: options.offline === true,
    url: options.registryUrl,
    timeoutMs: options.registryTimeoutMs ?? 5000,
    fetchImpl: options.fetch ?? fetch,
  }))

  // ---- gateway ports ----------------------------------------------------
  const skills = options.skills ?? []
  if (skills.length === 0) {
    push({
      id: 'ports',
      status: 'warn',
      code: EnvironmentCode.noSkills,
      detail: 'no skill installed, so no gateway port is claimed yet',
      hint: 'install a skill with forge_skill_install or drop a bundle under <home>/skills',
    })
  } else {
    for (const url of uniqueGatewayUrls(skills)) {
      const busy = await portBusy(url)
      push(busy
        ? {
            id: `port.${idSafe(url)}`,
            status: 'warn',
            code: EnvironmentCode.portBusy,
            detail: `${url} is already in use`,
            hint: 'stop the process holding it, or change gateway_url in the skill manifest',
          }
        : { id: `port.${idSafe(url)}`, status: 'pass', detail: `${url} is free` })
    }
  }

  // ---- runtime isolation ------------------------------------------------
  const stateFile = options.stateFile ?? join(options.home, 'runtime', 'state.json')
  const envRoot = options.envRoot ?? join(options.home, 'runtime', 'env')
  const persisted = await readRuntimeState(stateFile)
  const envDirs = await listEnvDirs(envRoot)
  const instances: EnvironmentRuntimeInstance[] = []
  for (const runtime of persisted.state) {
    const envDir = runtime.envDir
    const envDirExists = envDir !== undefined && envDirs.includes(envDir)
    const lock = envDirExists && envDir !== undefined ? await readRuntimeLock(envDir) : undefined
    instances.push({ ...runtime, envDirExists, ...(lock === undefined ? {} : { lock }) })
  }
  const referenced = new Set(instances.flatMap(instance => instance.envDir === undefined ? [] : [instance.envDir]))
  const orphans = envDirs.filter(dir => !referenced.has(dir))
  const runtimeContext: EnvironmentRuntimeContext = {
    stateFile,
    envRoot,
    stateExists: persisted.exists,
    instances,
    envDirs: envDirs.length,
    orphans,
    isolation: runtimeIsolation(envRoot),
  }

  if (!persisted.exists) {
    push({
      id: 'runtime.state',
      status: 'warn',
      detail: `no runtime recorded yet (${stateFile})`,
      hint: 'the file appears with the first forge_runtime_start',
    })
  } else if (persisted.error !== undefined) {
    push({
      id: 'runtime.state',
      status: 'warn',
      code: EnvironmentCode.runtimeStateBroken,
      detail: `${stateFile}: ${persisted.error}`,
      hint: 'the next start rewrites the file; delete it only when it stays corrupt',
    })
  } else {
    push({ id: 'runtime.state', status: 'pass', detail: `${instances.length} runtime(s) recorded` })
  }

  const missing = instances.filter(instance => instance.envDir !== undefined && !instance.envDirExists)
  if (missing.length > 0) {
    push({
      id: 'runtime.env',
      status: 'warn',
      code: EnvironmentCode.envMissing,
      detail: `${missing.length} recorded runtime(s) lost their env dir: ${missing
        .map(instance => `${instance.skill}/${instance.profile ?? '?'}`)
        .join(', ')}`,
      hint: 'start the skill again to re-materialize its isolated environment',
    })
  } else if (instances.length === 0) {
    push(orphans.length > 0
      ? {
          id: 'runtime.env',
          status: 'warn',
          code: EnvironmentCode.envStale,
          detail: `${orphans.length} leftover env dir(s) with no recorded runtime`,
          hint: `inspect ${envRoot}; remove directories for skills/profiles you no longer run`,
        }
      : { id: 'runtime.env', status: 'warn', detail: `no isolated env dir yet under ${envRoot}` })
  } else {
    push({ id: 'runtime.env', status: 'pass', detail: `${instances.length} isolated env dir(s) present` })
  }
  if (instances.length > 0) {
    push(orphans.length === 0
      ? { id: 'runtime.orphans', status: 'pass', detail: 'no orphan env dir' }
      : {
          id: 'runtime.orphans',
          status: 'warn',
          code: EnvironmentCode.envStale,
          detail: `${orphans.length} env dir(s) not referenced by any recorded runtime`,
          hint: `inspect ${envRoot} and remove directories for skills/profiles you no longer run`,
        })
  }

  const summary = {
    pass: checks.filter(check => check.status === 'pass').length,
    warn: checks.filter(check => check.status === 'warn').length,
    fail: checks.filter(check => check.status === 'fail').length,
  }
  const generatedAt = new Date().toISOString()
  const base: EnvironmentReport = {
    ok: summary.fail === 0,
    generatedAt,
    home: options.home,
    platform,
    node: `v${nodeVersion}`,
    summary,
    checks,
    runtime: runtimeContext,
  }
  if (options.writeReport === false) return base
  const path = await writeReport(base)
  return path === undefined ? base : { ...base, path }
}

/** Resolve a CLI: explicit value → env override → `<home>/support/bin/<name>` when present → PATH name. */
function resolveCli(explicit: string | undefined, override: string | undefined, home: string, name: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit
  if (override !== undefined && override.length > 0) return override
  const local = join(home, 'support', 'bin', name)
  return existsSync(local) ? local : name
}

const defaultExec: EnvironmentExec = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], { timeout: 5000 })
  return { stdout, stderr }
}

async function probe(file: string, args: readonly string[], exec: EnvironmentExec): Promise<Probe> {
  try {
    const { stdout, stderr } = await exec(file, args)
    return { ok: true, text: `${stdout}${stderr ?? ''}`.trim() }
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string }
    const text = `${failed.stdout ?? ''}${failed.stderr ?? ''}`.trim()
    return { ok: false, text: text.length > 0 ? text : (failed.message ?? String(error)) }
  }
}

function parseVersion(text: string): Version | undefined {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text)
  if (match === null) return undefined
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) }
}

function parseRequired(text: string): Version {
  const parsed = parseVersion(text)
  if (parsed === undefined) throw new Error(`not a version: ${text}`)
  return parsed
}

function atLeast(version: Version, minimum: Version): boolean {
  if (version.major !== minimum.major) return version.major > minimum.major
  if (version.minor !== minimum.minor) return version.minor > minimum.minor
  return version.patch >= minimum.patch
}

function formatVersion(version: Version): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

function firstLine(text: string): string {
  const line = text.split('\n').find(candidate => candidate.trim().length > 0)
  return line === undefined ? 'no output' : line.trim()
}

async function prepareHome(home: string, push: (check: EnvironmentCheck) => void, code: string): Promise<boolean> {
  const marker = join(home, `.environment-check-${process.pid}`)
  try {
    await mkdir(home, { recursive: true })
    await writeFile(marker, 'ok\n', { mode: 0o600 })
    await rm(marker, { force: true })
    push({ id: 'home', status: 'pass', detail: `${home} is writable` })
    return true
  } catch (error) {
    push({
      id: 'home',
      status: 'fail',
      code,
      detail: `${home}: ${(error as Error).message}`,
      hint: 'fix ownership or point home at a writable directory',
    })
    return false
  }
}

async function freeBytes(path: string): Promise<number | undefined> {
  try {
    const info = await statfs(path)
    return Number(info.bavail) * Number(info.bsize)
  } catch {
    return undefined
  }
}

async function checkRegistry(options: {
  offline: boolean
  url: string | undefined
  timeoutMs: number
  fetchImpl: typeof fetch
}): Promise<EnvironmentCheck> {
  if (options.offline) {
    return { id: 'registry', status: 'warn', detail: 'probe skipped (offline)' }
  }
  if (options.url === undefined || options.url.length === 0) {
    return {
      id: 'registry',
      status: 'warn',
      code: EnvironmentCode.registryUnreachable,
      detail: 'no registry URL configured',
      hint: 'set registry.url or DSH_FORGE_REGISTRY_URL; offline installs work from <home>/skills',
    }
  }
  const started = Date.now()
  try {
    const response = await options.fetchImpl(options.url, {
      method: 'GET',
      redirect: 'follow',
      signal: AbortSignal.timeout(options.timeoutMs),
    })
    const elapsed = Date.now() - started
    // 401/403 mean the endpoint answered; only transport failures block installs.
    const reachable = response.status < 500
    return reachable
      ? { id: 'registry', status: 'pass', detail: `HTTP ${response.status} in ${elapsed} ms (${options.url})` }
      : {
          id: 'registry',
          status: 'warn',
          code: EnvironmentCode.registryUnreachable,
          detail: `HTTP ${response.status} in ${elapsed} ms (${options.url})`,
          hint: 'the registry answered with a server error; installs may fail',
        }
  } catch (error) {
    return {
      id: 'registry',
      status: 'warn',
      code: EnvironmentCode.registryUnreachable,
      detail: `${options.url}: ${(error as Error).message}`,
      hint: 'online installs need a reachable registry; offline installs can drop bundles under <home>/skills',
    }
  }
}

function uniqueGatewayUrls(skills: readonly EnvironmentSkill[]): string[] {
  const seen = new Set<string>()
  const urls: string[] = []
  for (const skill of skills) {
    const url = skill.gatewayUrl
    if (url === undefined || url.length === 0 || seen.has(url)) continue
    seen.add(url)
    urls.push(url)
  }
  return urls
}

async function portBusy(url: string): Promise<boolean> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
  if (!Number.isInteger(port) || port <= 0) return false
  return new Promise<boolean>(resolvePort => {
    const socket = connect({ host: parsed.hostname, port })
    socket.setTimeout(500)
    socket.once('connect', () => {
      socket.destroy()
      resolvePort(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolvePort(false)
    })
    socket.once('error', () => resolvePort(false))
  })
}

/** Check ids stay printable: `port.http://127.0.0.1:19002` would read badly. */
function idSafe(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port.length > 0 ? parsed.port : 'default'}`
  } catch {
    return url.replace(/[^a-z0-9]+/gi, '-')
  }
}

async function writeReport(report: EnvironmentReport): Promise<string | undefined> {
  try {
    const dir = join(report.home, REPORT_DIR)
    const stamp = report.generatedAt.replace(/[:.]/g, '-')
    const path = join(dir, `env-${stamp}.json`)
    await mkdir(dir, { recursive: true })
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    return path
  } catch {
    return undefined
  }
}

/** Variables a materialized dataflow sees on top of `profile.environment`. */
const INJECTED_VARIABLES = [
  'FORGE_RUNTIME_BIN',
  'PAOS_SKILL_ROOT',
  'PAOS_SKILL_NAME',
  'PAOS_SKILL_VERSION',
  'PAOS_RUNTIME_INSTANCE_ID',
  'FORGE_FLOW_ID',
] as const

function runtimeIsolation(envRoot: string): EnvironmentIsolation {
  return {
    envDirTemplate: join(envRoot, '<skill>', '<profile>', '<hash>'),
    injected: INJECTED_VARIABLES,
    launch: {
      start: 'coordinator flow: dora up + dora start --detach, stopped by flow name; state.json keeps dora and launch=start',
      run: 'isolated process: dora run in its own process group, pid recorded in state.json, stopped by killing the group',
    },
  }
}

interface PersistedRuntimes {
  readonly exists: boolean
  readonly error?: string
  readonly state: readonly EnvironmentRuntime[]
}

async function readRuntimeState(file: string): Promise<PersistedRuntimes> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { exists: false, state: [] }
    return { exists: true, error: (error as Error).message, state: [] }
  }
  try {
    const parsed = JSON.parse(text) as { skills?: Record<string, unknown> }
    const state: EnvironmentRuntime[] = []
    for (const [skill, value] of Object.entries(parsed.skills ?? {})) {
      const runtime = pickRuntime(skill, value)
      if (runtime !== undefined) state.push(runtime)
    }
    return { exists: true, state }
  } catch (error) {
    return { exists: true, error: (error as Error).message, state: [] }
  }
}

function pickRuntime(skill: string, value: unknown): EnvironmentRuntime | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const text = (key: string): string | undefined =>
    typeof record[key] === 'string' ? (record[key] as string) : undefined
  const status = text('status') ?? 'unknown'
  const profile = text('profile')
  const flow = text('flow')
  const dora = text('dora')
  const forgeVersion = text('forgeVersion')
  const gatewayUrl = text('gatewayUrl')
  const envDir = text('envDir')
  const startedAt = text('startedAt')
  const launch = record['launch'] === 'run' ? 'run' : record['launch'] === 'start' ? 'start' : undefined
  return {
    skill,
    status,
    ...(profile === undefined ? {} : { profile }),
    ...(flow === undefined ? {} : { flow }),
    ...(launch === undefined ? {} : { launch }),
    ...(dora === undefined ? {} : { dora }),
    ...(forgeVersion === undefined ? {} : { forgeVersion }),
    ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
    ...(envDir === undefined ? {} : { envDir }),
    ...(startedAt === undefined ? {} : { startedAt }),
  }
}

async function readRuntimeLock(envDir: string): Promise<{ version?: string; artifacts?: number } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(join(envDir, 'runtime-lock.json'), 'utf8')) as {
      version?: unknown
      artifacts?: unknown
    }
    const version = typeof parsed.version === 'string' ? parsed.version : undefined
    const artifacts = typeof parsed.artifacts === 'object' && parsed.artifacts !== null
      ? Object.keys(parsed.artifacts as Record<string, unknown>).length
      : undefined
    const summary: { version?: string; artifacts?: number } = {}
    if (version !== undefined) summary.version = version
    if (artifacts !== undefined) summary.artifacts = artifacts
    return summary
  } catch {
    return undefined
  }
}

/** Enumerate `<envRoot>/<skill>/<profile>/<hash>` directories. */
async function listEnvDirs(envRoot: string): Promise<string[]> {
  const dirs: string[] = []
  for (const skill of await readdirSafe(envRoot)) {
    const skillDir = join(envRoot, skill)
    if (!(await isDirectory(skillDir))) continue
    for (const profile of await readdirSafe(skillDir)) {
      const profileDir = join(skillDir, profile)
      if (!(await isDirectory(profileDir))) continue
      for (const hash of await readdirSafe(profileDir)) {
        const dir = join(profileDir, hash)
        if (await isDirectory(dir)) dirs.push(dir)
      }
    }
  }
  return dirs
}

async function readdirSafe(path: string): Promise<string[]> {
  try {
    const entries = await readdir(path)
    return entries.filter(name => !name.startsWith('.'))
  } catch {
    return []
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
