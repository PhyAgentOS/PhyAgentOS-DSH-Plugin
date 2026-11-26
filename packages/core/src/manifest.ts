import { parse as parseYaml } from 'yaml'

import { ErrorCode } from './errors.js'

/** Manifest schema version this build understands. */
export const MANIFEST_VERSION = 2

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const ARTIFACT_TYPES = new Set(['executable_tar_gz', 'directory_tar_gz'])
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const SHA256_HEX = /^[a-f0-9]{64}$/i
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** One declarative model weight requirement inside `skill.yaml`. */
export interface ForgeModelRequirement {
  /** Logical model identifier, mapped to `<models>/<id>/<revision>/`. */
  readonly id: string
  /** Optional revision/variant directory name (e.g. `pinned_mirror`, `v1`). */
  readonly revision?: string
  /** Optional relative weight file inside the model revision directory (e.g. `sam3.pt`). */
  readonly filename?: string
  /** Optional pinned SHA256 digest of the weight file. */
  readonly sha256?: string
  /** Optional environment variable name injected with the resolved path at runtime. */
  readonly env?: string
  /** When true, missing weights warn during preflight instead of blocking start. */
  readonly optional?: boolean
}

/** One validation problem, addressed by its path inside `skill.yaml`. */
export interface ForgeIssue {
  /** Dot path inside the manifest, e.g. `profiles.piper_real.dataflow`. */
  readonly path: string
  /** Stable `FORGE_*` code. */
  readonly code: string
  /** Human-readable explanation. */
  readonly message: string
}

/** A deployment choice inside one skill bundle. */
export interface ForgeProfile {
  readonly id: string
  /** Bundle-relative path to the dataflow yaml. */
  readonly dataflow: string
  readonly requiredBinaries: readonly string[]
  readonly requiredAssets: readonly string[]
  readonly requiredEnvironment: readonly string[]
  readonly environment: Readonly<Record<string, string>>
  /** When present this overrides the manifest-level list instead of appending to it. */
  readonly requiredTools?: readonly string[]
  /** Profile-specific model requirements (merged over manifest-level by `id`). */
  readonly requiredModels?: readonly ForgeModelRequirement[]
  /**
   * Readiness budget in seconds for `forge start`. Absent keeps the runtime
   * default; heavy policy nodes routinely need far longer than it.
   */
  readonly startupTimeoutS?: number
}

/** One locked node artifact. */
export interface ForgeArtifactNode {
  readonly nodeId: string
  readonly artifactId: string
  readonly version: string
  readonly platform: string
  readonly arch: string
  readonly artifactType: string
  readonly entrypoint: string
  readonly sha256?: string
}

/** Parsed manifest-v2 skill bundle. */
export interface ForgeManifest {
  readonly name: string
  readonly version: string
  /**
   * Forge platform generation this bundle targets.
   * `'1'` = Forge 1.x (dora 0.4, forge-tool 1.x, gateway 1.x);
   * `'2'` = Forge 2.x (dora 1.x, forge-tool 2.x, gateway 2.x).
   */
  readonly forgeVersion: '1' | '2'
  readonly description: string
  /** Instruction document, relative to the bundle root. */
  readonly skillDocument: string
  /** Gateway base URL; a skill-level field shared by every profile. */
  readonly gatewayUrl?: string
  readonly requiredTools: readonly string[]
  readonly requiredModels?: readonly ForgeModelRequirement[]
  readonly profiles: Readonly<Record<string, ForgeProfile>>
  readonly artifacts: Readonly<Record<string, ForgeArtifactNode>>
}

/** Outcome of parsing one `skill.yaml`; `manifest` is absent when any issue failed validation. */
export interface ParsedManifest {
  readonly manifest?: ForgeManifest
  readonly issues: readonly ForgeIssue[]
}

/**
 * Parse and validate a `skill.yaml` document.
 *
 * Unknown keys are ignored on purpose: the manifest is authored by third parties
 * and the runtime contract is the subset validated here.
 */
export function parseManifest(text: string, source = 'skill.yaml'): ParsedManifest {
  const issues: ForgeIssue[] = []
  const add = (path: string, code: string, message: string): void => {
    issues.push({ path, code, message })
  }

  let raw: unknown
  try {
    raw = parseYaml(text)
  } catch (error) {
    add(source, ErrorCode.manifestInvalid, `invalid YAML: ${(error as Error).message}`)
    return { issues }
  }
  if (!isRecord(raw)) {
    add(source, ErrorCode.manifestInvalid, 'manifest root must be a mapping')
    return { issues }
  }

  if (raw['manifest_version'] !== MANIFEST_VERSION) {
    add('manifest_version', ErrorCode.manifestInvalid, `expected ${MANIFEST_VERSION}, got ${String(raw['manifest_version'])}`)
  }

  const forgeVersion = readForgeVersion(raw['forge_version'], add)
  const name = readString(raw, 'name', add)
  if (name !== undefined && !SKILL_NAME.test(name)) {
    add('name', ErrorCode.manifestInvalid, `"${name}" is not kebab-case`)
  }

  const version = readString(raw, 'version', add)
  if (version !== undefined && !SEMVER.test(version)) {
    add('version', ErrorCode.manifestInvalid, `"${version}" is not a semver version`)
  }

  const description = readString(raw, 'description', add)
  if (description !== undefined && description.trim().length === 0) {
    add('description', ErrorCode.manifestInvalid, 'description must not be empty')
  }

  const skillDocument = readString(raw, 'skill_document', add) ?? 'SKILL.md'

  let gatewayUrl: string | undefined
  const rawGateway = raw['gateway_url']
  if (rawGateway !== undefined) {
    if (typeof rawGateway !== 'string') {
      add('gateway_url', ErrorCode.manifestInvalid, 'gateway_url must be a string')
    } else if (!isHttpUrl(rawGateway)) {
      add('gateway_url', ErrorCode.manifestInvalid, `"${rawGateway}" is not an http(s) URL`)
    } else {
      gatewayUrl = rawGateway
    }
  } else {
    add('gateway_url', ErrorCode.manifestInvalid, 'gateway_url is required')
  }

  const requiredTools = readStringArray(raw['required_tools'], 'required_tools', add) ?? []
  const requiredModels = readRequiredModels(raw['required_models'], 'required_models', add)
  const profiles = readProfiles(raw['profiles'], add)
  const artifacts = readArtifacts(raw['artifacts'], add)

  if (issues.length > 0 || name === undefined || version === undefined || description === undefined) {
    return { issues }
  }

  const manifest: ForgeManifest = {
    name,
    version,
    forgeVersion,
    description,
    skillDocument,
    ...(gatewayUrl === undefined ? {} : { gatewayUrl }),
    requiredTools,
    ...(requiredModels.length === 0 ? {} : { requiredModels }),
    profiles,
    artifacts,
  }
  return { manifest, issues }
}

/** Resolve the tool list that a profile actually exposes (override, not append). */
export function toolsForProfile(manifest: ForgeManifest, profileId: string): readonly string[] {
  const profile = manifest.profiles[profileId]
  return profile?.requiredTools ?? manifest.requiredTools
}

/** Resolve effective model requirements for one profile (profile entries override manifest entries of the same `id`). */
export function modelsForProfile(manifest: ForgeManifest, profileId: string): readonly ForgeModelRequirement[] {
  const merged = new Map<string, ForgeModelRequirement>()
  for (const model of manifest.requiredModels ?? []) merged.set(model.id, model)
  const profile = manifest.profiles[profileId]
  for (const model of profile?.requiredModels ?? []) merged.set(model.id, model)
  return [...merged.values()]
}

/**
 * Read `forge_version`, defaulting to `'1'` so every existing (Forge 1.x) bundle
 * keeps parsing unchanged. `'1.x'` / `'2.x'` are normalized to their major.
 */
function readForgeVersion(value: unknown, add: AddIssue): '1' | '2' {
  if (value === undefined) return '1'
  if (typeof value === 'number' && (value === 1 || value === 2)) return value === 2 ? '2' : '1'
  if (typeof value !== 'string') {
    add('forge_version', ErrorCode.manifestInvalid, 'forge_version must be "1" or "2"')
    return '1'
  }
  const text = value.trim()
  const major = text.split('.')[0]
  if (major === '1' || major === '2') return major
  add('forge_version', ErrorCode.manifestInvalid, `"${text}" is not a supported Forge generation ("1" or "2")`)
  return '1'
}

/**
 * Read `startup_timeout_s` (seconds). Absent means "use the runtime default", so
 * every existing bundle keeps its current behaviour.
 */
function readStartupTimeoutS(value: unknown, path: string, add: AddIssue): number | undefined {
  if (value === undefined)
    return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    add(path, ErrorCode.manifestInvalid, 'startup_timeout_s must be a positive integer (seconds)')
    return undefined
  }
  return value
}
function readProfiles(value: unknown, add: AddIssue): Record<string, ForgeProfile> {
  if (!isRecord(value)) {
    add('profiles', ErrorCode.manifestInvalid, 'profiles must be a mapping')
    return {}
  }
  const profiles: Record<string, ForgeProfile> = {}
  for (const [id, raw] of Object.entries(value)) {
    const base = `profiles.${id}`
    if (!isRecord(raw)) {
      add(base, ErrorCode.manifestInvalid, 'profile must be a mapping')
      continue
    }
    const dataflow = readString(raw, 'dataflow', add, base)
    if (dataflow === undefined) {
      add(`${base}.dataflow`, ErrorCode.manifestInvalid, 'dataflow is required')
      continue
    }
    const startupTimeoutS = readStartupTimeoutS(raw['startup_timeout_s'], `${base}.startup_timeout_s`, add)
    profiles[id] = {
      id,
      dataflow,
      ...(startupTimeoutS === undefined ? {} : { startupTimeoutS }),
      requiredBinaries: readStringArray(raw['required_binaries'], `${base}.required_binaries`, add) ?? [],
      requiredAssets: readStringArray(raw['required_assets'], `${base}.required_assets`, add) ?? [],
      requiredEnvironment: readStringArray(raw['required_environment'], `${base}.required_environment`, add) ?? [],
      environment: readStringMap(raw['environment'], `${base}.environment`, add),
      ...(() => {
        const requiredTools = readStringArray(raw['required_tools'], `${base}.required_tools`, add)
        return requiredTools === undefined ? {} : { requiredTools }
      })(),
      ...(() => {
        const requiredModels = readRequiredModels(raw['required_models'], `${base}.required_models`, add)
        return requiredModels.length === 0 ? {} : { requiredModels }
      })(),
    }
  }
  if (Object.keys(profiles).length === 0) {
    add('profiles', ErrorCode.manifestInvalid, 'at least one profile is required')
  }
  return profiles
}

function readArtifacts(value: unknown, add: AddIssue): Record<string, ForgeArtifactNode> {
  if (value === undefined) return {}
  if (!isRecord(value)) {
    add('artifacts', ErrorCode.manifestInvalid, 'artifacts must be a mapping')
    return {}
  }
  const nodes = value['nodes']
  if (nodes === undefined) return {}
  if (!isRecord(nodes)) {
    add('artifacts.nodes', ErrorCode.manifestInvalid, 'artifacts.nodes must be a mapping')
    return {}
  }

  const artifacts: Record<string, ForgeArtifactNode> = {}
  for (const [nodeId, raw] of Object.entries(nodes)) {
    const base = `artifacts.nodes.${nodeId}`
    if (!isRecord(raw)) {
      add(base, ErrorCode.manifestInvalid, 'artifact lock must be a mapping')
      continue
    }
    const artifactId = readString(raw, 'artifact_id', add, base)
    const version = readString(raw, 'version', add, base)
    const platform = readString(raw, 'platform', add, base)
    const arch = readString(raw, 'arch', add, base)
    const artifactType = readString(raw, 'artifact_type', add, base)
    const entrypoint = readString(raw, 'entrypoint', add, base)
    if (artifactId === undefined || version === undefined || platform === undefined
      || arch === undefined || artifactType === undefined || entrypoint === undefined) {
      continue
    }
    if (!ARTIFACT_TYPES.has(artifactType)) {
      add(`${base}.artifact_type`, ErrorCode.manifestInvalid, `"${artifactType}" is not a known archive type`)
      continue
    }
    const sha256 = readString(raw, 'sha256', add, base)
    artifacts[nodeId] = {
      nodeId,
      artifactId,
      version,
      platform,
      arch,
      artifactType,
      entrypoint,
      ...(sha256 === undefined ? {} : { sha256 }),
    }
  }
  return artifacts
}

type AddIssue = (path: string, code: string, message: string) => void

function readString(raw: Record<string, unknown>, key: string, add: AddIssue, base = ''): string | undefined {
  const value = raw[key]
  const path = base.length === 0 ? key : `${base}.${key}`
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    add(path, ErrorCode.manifestInvalid, `${key} must be a string`)
    return undefined
  }
  return value
}

function readStringArray(value: unknown, path: string, add: AddIssue): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    add(path, ErrorCode.manifestInvalid, `${path} must be an array of strings`)
    return undefined
  }
  return value as string[]
}

function readStringMap(value: unknown, path: string, add: AddIssue): Record<string, string> {
  if (value === undefined) return {}
  if (!isRecord(value) || Object.values(value).some(item => typeof item !== 'string')) {
    add(path, ErrorCode.manifestInvalid, `${path} must map strings to strings`)
    return {}
  }
  return value as Record<string, string>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRequiredModels(value: unknown, path: string, add: AddIssue): ForgeModelRequirement[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) {
    add(path, ErrorCode.manifestInvalid, `${path} must be a list`)
    return []
  }
  const models: ForgeModelRequirement[] = []
  for (let index = 0; index < value.length; index += 1) {
    const base = `${path}[${index}]`
    const raw = value[index]
    if (!isRecord(raw)) {
      add(base, ErrorCode.manifestInvalid, 'model requirement must be a mapping')
      continue
    }
    const id = readString(raw, 'id', add, base)
    if (id === undefined || id.length === 0) {
      add(`${base}.id`, ErrorCode.manifestInvalid, 'id is required')
      continue
    }
    if (!SAFE_SEGMENT.test(id)) {
      add(`${base}.id`, ErrorCode.manifestInvalid, `"${id}" is not a valid model id`)
      continue
    }
    const revision = readString(raw, 'revision', add, base)
    if (revision !== undefined && !SAFE_SEGMENT.test(revision)) {
      add(`${base}.revision`, ErrorCode.manifestInvalid, `"${revision}" is not a valid model revision`)
      continue
    }
    const filename = readString(raw, 'filename', add, base)
    if (filename !== undefined) {
      const normalized = filename.replace(/\\/g, '/')
      if (normalized.length === 0 || normalized.startsWith('/') || normalized.split('/').some(seg => seg === '..' || seg === '.')) {
        add(`${base}.filename`, ErrorCode.manifestInvalid, `"${filename}" must be a relative path inside the model directory`)
        continue
      }
    }
    const sha256 = readString(raw, 'sha256', add, base)
    if (sha256 !== undefined && !SHA256_HEX.test(sha256)) {
      add(`${base}.sha256`, ErrorCode.manifestInvalid, `"${sha256}" must be a 64-character hex sha256 digest`)
      continue
    }
    const env = readString(raw, 'env', add, base)
    if (env !== undefined && !ENV_NAME.test(env)) {
      add(`${base}.env`, ErrorCode.manifestInvalid, `"${env}" is not a valid environment variable name`)
      continue
    }
    let optional: boolean | undefined
    if (raw['optional'] !== undefined) {
      if (typeof raw['optional'] !== 'boolean') {
        add(`${base}.optional`, ErrorCode.manifestInvalid, 'optional must be a boolean')
        continue
      }
      optional = raw['optional']
    }
    models.push({
      id,
      ...(revision === undefined ? {} : { revision }),
      ...(filename === undefined ? {} : { filename }),
      ...(sha256 === undefined ? {} : { sha256: sha256.toLowerCase() }),
      ...(env === undefined ? {} : { env }),
      ...(optional === undefined ? {} : { optional }),
    })
  }
  return models
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
