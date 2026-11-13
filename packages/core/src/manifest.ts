import { parse as parseYaml } from 'yaml'

import { ErrorCode } from './errors.js'

/** Manifest schema version this build understands. */
export const MANIFEST_VERSION = 2

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
const ARTIFACT_TYPES = new Set(['executable_tar_gz', 'directory_tar_gz'])

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
    profiles[id] = {
      id,
      dataflow,
      requiredBinaries: readStringArray(raw['required_binaries'], `${base}.required_binaries`, add) ?? [],
      requiredAssets: readStringArray(raw['required_assets'], `${base}.required_assets`, add) ?? [],
      requiredEnvironment: readStringArray(raw['required_environment'], `${base}.required_environment`, add) ?? [],
      environment: readStringMap(raw['environment'], `${base}.environment`, add),
      ...(() => {
        const requiredTools = readStringArray(raw['required_tools'], `${base}.required_tools`, add)
        return requiredTools === undefined ? {} : { requiredTools }
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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}
