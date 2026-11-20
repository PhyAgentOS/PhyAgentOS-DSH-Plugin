import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, rm, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import {
  checkEnvironment,
  type EnvironmentExec,
  type EnvironmentReport,
  type EnvironmentSkill,
} from './environment.js'
import { expandHome, forgePaths } from './paths.js'
import { DshProfileStore, type ForgeRowConfig } from './settings.js'

const execFileAsync = promisify(execFile)

/** Default pinned Forge 1 Dora CLI version (`dora-rs-cli` on PyPI). */
export const DEFAULT_DORA_VERSION = '0.4.1'
/** Default pinned Forge 2 Dora CLI version (`dora-rs-cli` on PyPI). */
export const DEFAULT_DORA1_VERSION = '1.0.1'

export type BootstrapComponent = 'directories' | 'dora' | 'dora1' | 'profileConfig'

export type BootstrapStepStatus = 'planned' | 'installed' | 'kept' | 'updated' | 'skipped' | 'failed'

export interface BootstrapStep {
  readonly id: string
  readonly status: BootstrapStepStatus
  readonly target?: string
  readonly version?: string
  readonly command?: string
  readonly detail: string
  readonly hint?: string
}

/** Injectable command runner used for probing and installing runtimes. */
export type BootstrapExec = (
  file: string,
  args: readonly string[],
  options?: { readonly timeoutMs?: number; readonly env?: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr?: string }>

export interface BootstrapOptions {
  /** Forge data root (defaults to `~/.dsh/forge`). */
  readonly home: string
  /** Optional override for the shared models root. */
  readonly modelsRoot?: string | undefined
  /** Subset of components to configure; defaults to `['directories', 'dora', 'dora1']`. */
  readonly components?: readonly BootstrapComponent[] | undefined
  /** Forge 1 `dora-rs-cli` version to install when missing (default `0.4.1`). */
  readonly doraVersion?: string | undefined
  /** Forge 2 `dora-rs-cli` version to install when missing (default `1.0.1`). */
  readonly dora1Version?: string | undefined
  /** Optional local executable to install as `<home>/support/bin/dora` instead of downloading. */
  readonly doraBinaryPath?: string | undefined
  /** Optional local executable to install as `<home>/support/bin/dora1` instead of downloading. */
  readonly dora1BinaryPath?: string | undefined
  /** Optional Python interpreter or version selector (e.g. `python3.12` or `3.12`). */
  readonly python?: string | undefined
  /** Optional PyPI index URL / mirror (e.g. `https://pypi.tuna.tsinghua.edu.cn/simple`). */
  readonly indexUrl?: string | undefined
  /** Reinstall even when an existing `dora` / `dora1` already matches the expected generation. */
  readonly force?: boolean | undefined
  /** Return the exact plan without writing files or running installers. */
  readonly dryRun?: boolean | undefined
  /** Also write `runtime.dora` / `runtime.dora1` into `<profile>/cordis.patch.yml`. */
  readonly writeProfileConfig?: boolean | undefined
  /** DSH profile name used when `writeProfileConfig` is true (default `web`). */
  readonly profile?: string | undefined
  /** Override DSH profiles root (primarily for tests). */
  readonly profilesRoot?: string | undefined
  /** Run `checkEnvironment` after setup when `dryRun` is false (default `true`). */
  readonly verify?: boolean | undefined
  /** Skip registry probe during post-setup `checkEnvironment`. */
  readonly offline?: boolean | undefined
  readonly registryUrl?: string | undefined
  readonly skills?: readonly EnvironmentSkill[] | undefined
  readonly env?: NodeJS.ProcessEnv | undefined
  readonly exec?: BootstrapExec | undefined
}

export interface BootstrapBinarySummary {
  readonly path: string
  readonly version?: string
  readonly status: BootstrapStepStatus
}

export interface BootstrapResult {
  readonly ok: boolean
  readonly dryRun: boolean
  readonly home: string
  readonly modelsRoot: string
  readonly supportBin: string
  readonly installer: 'uv' | 'python' | 'none'
  readonly dora: BootstrapBinarySummary
  readonly dora1: BootstrapBinarySummary
  readonly steps: readonly BootstrapStep[]
  readonly environment?: EnvironmentReport
}

interface ParsedVersion {
  readonly major: number
  readonly minor: number
  readonly patch: number
}

interface InstallerTool {
  readonly kind: 'uv' | 'python' | 'none'
  readonly command?: string
  readonly detail: string
}

/**
 * Deterministically prepare a machine's Forge base runtime environment under `<home>`.
 *
 * Installs pinned Forge 1 (`dora` 0.4.1) and Forge 2 (`dora1` 1.0.1) CLIs into isolated
 * environments under `<home>/support/` and links them at `<home>/support/bin/{dora,dora1}`
 * so `SkillRuntimeManager` and `checkEnvironment` auto-discover them without touching the
 * global PATH. Supports `dryRun` planning, local binary installation, PyPI mirror override,
 * optional `cordis.patch.yml` updates, and closed-loop post-setup verification.
 */
export async function bootstrapEnvironment(options: BootstrapOptions): Promise<BootstrapResult> {
  const env = options.env ?? process.env
  const exec = options.exec ?? defaultExec
  const paths = forgePaths(options.home, options.modelsRoot)
  const supportRoot = join(paths.home, 'support')
  const supportBin = join(supportRoot, 'bin')
  const doraTarget = join(supportBin, 'dora')
  const dora1Target = join(supportBin, 'dora1')
  const doraVersion = options.doraVersion ?? DEFAULT_DORA_VERSION
  const dora1Version = options.dora1Version ?? DEFAULT_DORA1_VERSION
  const dryRun = options.dryRun === true
  const force = options.force === true

  const requested = new Set<BootstrapComponent>(
    options.components ?? (
      options.writeProfileConfig === true
        ? ['directories', 'dora', 'dora1', 'profileConfig']
        : ['directories', 'dora', 'dora1']
    ),
  )
  if (options.writeProfileConfig === true) requested.add('profileConfig')

  const steps: BootstrapStep[] = []
  const installer = await detectInstaller(options.python, env, exec)

  // ---- 1. Directories ---------------------------------------------------
  const managedDirs = [
    paths.home,
    paths.skills,
    paths.models,
    join(paths.models, 'cache'),
    supportRoot,
    supportBin,
    paths.runtime,
  ]
  if (requested.has('directories')) {
    if (dryRun) {
      steps.push({
        id: 'directories',
        status: 'planned',
        target: paths.home,
        detail: `ensure Forge directories under ${paths.home} (skills, models, support/bin, runtime)`,
      })
    } else {
      try {
        for (const dir of managedDirs) await mkdir(dir, { recursive: true })
        steps.push({
          id: 'directories',
          status: 'updated',
          target: paths.home,
          detail: `ensured Forge directories under ${paths.home} and models root ${paths.models}`,
        })
      } catch (error) {
        steps.push({
          id: 'directories',
          status: 'failed',
          target: paths.home,
          detail: `failed to create Forge directories: ${(error as Error).message}`,
          hint: 'check write permissions on the Forge home and models root',
        })
      }
    }
  } else {
    steps.push({ id: 'directories', status: 'skipped', target: paths.home, detail: 'not requested' })
  }

  // ---- 2. Forge 1 dora (0.4.1 baseline) ---------------------------------
  const doraSummary = await setupDoraGeneration({
    id: 'dora',
    enabled: requested.has('dora'),
    generation: '1',
    targetBin: doraTarget,
    venvDir: join(supportRoot, 'dora-venv'),
    pinnedVersion: doraVersion,
    localBinaryPath: options.doraBinaryPath,
    python: options.python,
    indexUrl: options.indexUrl,
    installer,
    force,
    dryRun,
    env,
    exec,
    steps,
  })

  // ---- 3. Forge 2 dora1 (>=1.0.1,<2) ------------------------------------
  const dora1Summary = await setupDoraGeneration({
    id: 'dora1',
    enabled: requested.has('dora1'),
    generation: '2',
    targetBin: dora1Target,
    venvDir: join(supportRoot, 'dora1-venv'),
    pinnedVersion: dora1Version,
    localBinaryPath: options.dora1BinaryPath,
    python: options.python,
    indexUrl: options.indexUrl,
    installer,
    force,
    dryRun,
    env,
    exec,
    steps,
  })

  // ---- 4. Optional DSH profile cordis.patch.yml update ------------------
  if (requested.has('profileConfig')) {
    const profile = options.profile ?? 'web'
    const store = new DshProfileStore({ profilesRoot: options.profilesRoot })
    const snapshot = await store.read(profile)
    const nextConfig: ForgeRowConfig = mergeForgeRowConfig(snapshot.config, {
      runtime: {
        ...(doraSummary.status !== 'failed' ? { dora: doraTarget } : {}),
        ...(dora1Summary.status !== 'failed' ? { dora1: dora1Target } : {}),
      },
      ...(options.modelsRoot !== undefined && options.modelsRoot.length > 0
        ? { models: { root: paths.models } }
        : {}),
    })
    if (dryRun) {
      steps.push({
        id: 'profileConfig',
        status: 'planned',
        target: snapshot.path,
        detail: `update forge-skill config in profile "${profile}" (${snapshot.path}) with runtime.dora / runtime.dora1`,
      })
    } else {
      try {
        const written = await store.write(profile, nextConfig)
        steps.push({
          id: 'profileConfig',
          status: 'updated',
          target: written.path,
          detail: `updated profile "${profile}" (${written.path})${written.backup ? `; backup: ${written.backup}` : ''}`,
        })
      } catch (error) {
        steps.push({
          id: 'profileConfig',
          status: 'failed',
          target: snapshot.path,
          detail: `failed to update profile "${profile}": ${(error as Error).message}`,
          hint: 'verify the profile directory exists and cordis.patch.yml contains a valid YAML list',
        })
      }
    }
  } else {
    steps.push({
      id: 'profileConfig',
      status: 'skipped',
      detail: 'not requested (<home>/support/bin/{dora,dora1} is auto-discovered without editing cordis.patch.yml)',
    })
  }

  // ---- 5. Closed-loop verification --------------------------------------
  const stepFailed = steps.some(step => step.status === 'failed')
  let environment: EnvironmentReport | undefined
  if (!dryRun && options.verify !== false) {
    const envExec: EnvironmentExec = async (file, args) => exec(file, args, { timeoutMs: 5000, env })
    environment = await checkEnvironment({
      home: paths.home,
      modelsRoot: paths.models,
      dora: existsSync(doraTarget) ? doraTarget : undefined,
      dora1: existsSync(dora1Target) ? dora1Target : undefined,
      registryUrl: options.registryUrl,
      skills: options.skills,
      offline: options.offline,
      env,
      exec: envExec,
    })
  }

  const ok = !stepFailed && (environment === undefined ? true : environment.ok)
  return {
    ok,
    dryRun,
    home: paths.home,
    modelsRoot: paths.models,
    supportBin,
    installer: installer.kind,
    dora: doraSummary,
    dora1: dora1Summary,
    steps,
    ...(environment === undefined ? {} : { environment }),
  }
}

/** Merge partial config sections onto an existing `ForgeRowConfig` without clobbering sibling keys. */
export function mergeForgeRowConfig(
  current: ForgeRowConfig,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const prev = result[key]
    if (isPlainObject(prev) && isPlainObject(value)) {
      result[key] = { ...prev, ...value }
    } else {
      result[key] = value
    }
  }
  return result
}

interface SetupDoraArgs {
  readonly id: 'dora' | 'dora1'
  readonly enabled: boolean
  readonly generation: '1' | '2'
  readonly targetBin: string
  readonly venvDir: string
  readonly pinnedVersion: string
  readonly localBinaryPath?: string | undefined
  readonly python?: string | undefined
  readonly indexUrl?: string | undefined
  readonly installer: InstallerTool
  readonly force: boolean
  readonly dryRun: boolean
  readonly env: NodeJS.ProcessEnv
  readonly exec: BootstrapExec
  readonly steps: BootstrapStep[]
}

async function setupDoraGeneration(args: SetupDoraArgs): Promise<BootstrapBinarySummary> {
  const { id, generation, targetBin, venvDir, pinnedVersion, force, dryRun, env, exec, steps } = args
  if (!args.enabled) {
    steps.push({ id, status: 'skipped', target: targetBin, detail: 'not requested' })
    return { path: targetBin, status: 'skipped' }
  }

  // Check if an existing executable at targetBin already satisfies this generation.
  if (!force && existsSync(targetBin)) {
    const existing = await probeDoraVersion(targetBin, exec, env)
    if (existing.ok && existing.version !== undefined && matchesGeneration(generation, existing.version)) {
      const formatted = formatVersion(existing.version)
      steps.push({
        id,
        status: 'kept',
        target: targetBin,
        version: formatted,
        detail: `dora-cli ${formatted} already ready at ${targetBin} (pass force=true to reinstall)`,
      })
      return { path: targetBin, version: formatted, status: 'kept' }
    }
  }

  // Option A: Install from a caller-provided local executable path.
  if (args.localBinaryPath !== undefined && args.localBinaryPath.length > 0) {
    const source = resolve(expandHome(args.localBinaryPath))
    const command = `install ${source} -> ${targetBin}`
    if (dryRun) {
      steps.push({
        id,
        status: 'planned',
        target: targetBin,
        command,
        detail: `copy local executable ${source} to ${targetBin} and verify Forge ${generation} version`,
      })
      return { path: targetBin, status: 'planned' }
    }
    const probe = await probeDoraVersion(source, exec, env)
    if (!probe.ok || probe.version === undefined || !matchesGeneration(generation, probe.version)) {
      steps.push({
        id,
        status: 'failed',
        target: targetBin,
        command,
        detail: `${source} is not a valid Forge ${generation} dora binary: ${probe.text}`,
        hint: generation === '1'
          ? 'provide a dora-cli 0.4.x executable (baseline 0.4.1)'
          : 'provide a dora-cli >=1.0.1,<2 executable',
      })
      return { path: targetBin, status: 'failed' }
    }
    try {
      await mkdir(join(targetBin, '..'), { recursive: true })
      await rm(targetBin, { force: true })
      await copyFile(source, targetBin)
      await chmod(targetBin, 0o755)
      const formatted = formatVersion(probe.version)
      steps.push({
        id,
        status: 'installed',
        target: targetBin,
        version: formatted,
        command,
        detail: `installed dora-cli ${formatted} from ${source} to ${targetBin}`,
      })
      return { path: targetBin, version: formatted, status: 'installed' }
    } catch (error) {
      steps.push({
        id,
        status: 'failed',
        target: targetBin,
        command,
        detail: `failed to copy ${source} to ${targetBin}: ${(error as Error).message}`,
      })
      return { path: targetBin, status: 'failed' }
    }
  }

  // Option B: Install pinned `dora-rs-cli==<version>` into an isolated venv under `<home>/support/`.
  if (args.installer.kind === 'none' || args.installer.command === undefined) {
    steps.push({
      id,
      status: 'failed',
      target: targetBin,
      detail: `no uv or Python interpreter found to create ${venvDir}`,
      hint: 'install uv (recommended) or python3 >= 3.11 with venv/pip, or supply doraBinaryPath / dora1BinaryPath',
    })
    return { path: targetBin, status: 'failed' }
  }

  const venvPython = join(venvDir, 'bin', 'python')
  const venvDora = join(venvDir, 'bin', 'dora')
  const pkgSpec = `dora-rs-cli==${pinnedVersion}`
  const indexArgs = args.indexUrl !== undefined && args.indexUrl.length > 0 ? ['--index-url', args.indexUrl] : []
  const pythonSpec = args.python !== undefined && args.python.length > 0 ? args.python : '3.12'

  const createCmd: [string, string[]] = args.installer.kind === 'uv'
    ? [args.installer.command, ['venv', '--python', pythonSpec, '--clear', venvDir]]
    : [args.installer.command, ['-m', 'venv', '--clear', venvDir]]

  const installCmd: [string, string[]] = args.installer.kind === 'uv'
    ? [args.installer.command, ['pip', 'install', '--python', venvPython, ...indexArgs, pkgSpec]]
    : [venvPython, ['-m', 'pip', 'install', ...indexArgs, pkgSpec]]

  const displayCommand = `${formatCommand(createCmd)} && ${formatCommand(installCmd)}`

  if (dryRun) {
    steps.push({
      id,
      status: 'planned',
      target: targetBin,
      version: pinnedVersion,
      command: displayCommand,
      detail: `install ${pkgSpec} into isolated venv ${venvDir} via ${args.installer.kind} and link ${targetBin}`,
    })
    return { path: targetBin, version: pinnedVersion, status: 'planned' }
  }

  try {
    await mkdir(join(targetBin, '..'), { recursive: true })
    if (force) await rm(venvDir, { recursive: true, force: true })
    await exec(createCmd[0], createCmd[1], { timeoutMs: 180000, env })
    await exec(installCmd[0], installCmd[1], { timeoutMs: 300000, env })
    await rm(targetBin, { force: true })
    const relativeTarget = join('..', `${id}-venv`, 'bin', 'dora')
    await symlink(relativeTarget, targetBin)
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string }
    const output = `${failed.stderr ?? ''}\n${failed.stdout ?? ''}`.trim()
    steps.push({
      id,
      status: 'failed',
      target: targetBin,
      version: pinnedVersion,
      command: displayCommand,
      detail: `failed to install ${pkgSpec}: ${firstLine(output.length > 0 ? output : (failed.message ?? String(error)))}`,
      hint: args.indexUrl === undefined
        ? 'if PyPI is slow or blocked, retry with indexUrl (e.g. a PyPI mirror) or supply a local binary path'
        : 'check network access to the configured indexUrl and Python compatibility',
    })
    return { path: targetBin, status: 'failed' }
  }

  const probe = await probeDoraVersion(existsSync(targetBin) ? targetBin : venvDora, exec, env)
  if (!probe.ok || probe.version === undefined || !matchesGeneration(generation, probe.version)) {
    steps.push({
      id,
      status: 'failed',
      target: targetBin,
      version: pinnedVersion,
      command: displayCommand,
      detail: `installed ${pkgSpec} but verification failed at ${targetBin}: ${probe.text}`,
      hint: `expected Forge ${generation} dora-cli version; inspect ${venvDir}`,
    })
    return { path: targetBin, status: 'failed' }
  }

  const formatted = formatVersion(probe.version)
  steps.push({
    id,
    status: 'installed',
    target: targetBin,
    version: formatted,
    command: displayCommand,
    detail: `installed dora-cli ${formatted} in ${venvDir} and linked ${targetBin}`,
  })
  return { path: targetBin, version: formatted, status: 'installed' }
}

async function detectInstaller(
  explicitPython: string | undefined,
  env: NodeJS.ProcessEnv,
  exec: BootstrapExec,
): Promise<InstallerTool> {
  // Prefer `uv` when available: fast installs and automatic managed Python 3.12 support.
  try {
    const { stdout } = await exec('uv', ['--version'], { timeoutMs: 5000, env })
    return { kind: 'uv', command: 'uv', detail: firstLine(stdout) }
  } catch {
    // fall back to python -m venv
  }

  const candidates = [
    explicitPython,
    env['DSH_FORGE_PYTHON'],
    'python3.12',
    'python3.11',
    'python3',
  ].filter((value, index, list): value is string => value !== undefined && value.length > 0 && list.indexOf(value) === index)

  for (const candidate of candidates) {
    try {
      const { stdout, stderr } = await exec(candidate, ['--version'], { timeoutMs: 5000, env })
      const text = `${stdout}${stderr ?? ''}`.trim()
      if (parseVersion(text) !== undefined) {
        return { kind: 'python', command: candidate, detail: firstLine(text) }
      }
    } catch {
      // try next candidate
    }
  }
  return { kind: 'none', detail: 'neither uv nor python3 is runnable' }
}

async function probeDoraVersion(
  binary: string,
  exec: BootstrapExec,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; text: string; version?: ParsedVersion }> {
  try {
    const { stdout, stderr } = await exec(binary, ['--version'], { timeoutMs: 5000, env })
    const text = `${stdout}${stderr ?? ''}`.trim()
    const version = parseVersion(text)
    return { ok: true, text, ...(version === undefined ? {} : { version }) }
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; message?: string }
    const text = `${failed.stdout ?? ''}${failed.stderr ?? ''}`.trim()
    return { ok: false, text: text.length > 0 ? text : (failed.message ?? String(error)) }
  }
}

function matchesGeneration(generation: '1' | '2', version: ParsedVersion): boolean {
  if (generation === '1') return version.major === 0 && version.minor === 4
  return version.major === 1 && (version.minor > 0 || version.patch >= 1)
}

function parseVersion(text: string): ParsedVersion | undefined {
  const match = /\b(\d+)\.(\d+)(?:\.(\d+))?\b/.exec(text)
  if (match === null) return undefined
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? '0'),
  }
}

function formatVersion(version: ParsedVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map(line => line.trim()).find(line => line.length > 0) ?? '(no output)'
}

function formatCommand([file, args]: readonly [string, readonly string[]]): string {
  return [file, ...args].map(part => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ')
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const defaultExec: BootstrapExec = async (file, args, options) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    timeout: options?.timeoutMs ?? 60000,
    env: options?.env,
  })
  return { stdout, stderr }
}
