import { ForgeError } from './errors.js'

/** One downloadable artifact resolved from a resource registry. */
/** Source pinning metadata returned by updated registry deployments. */
export interface RegistrySource {
  readonly repositoryUrl?: string
  readonly ref?: string
  readonly refType?: string
  readonly commitSha?: string
  readonly path?: string
  readonly archiveUrl?: string
  readonly rawBaseUrl?: string
  readonly browseUrl?: string
  readonly verifiedAt?: number
}

export interface RegistryArtifact {
  readonly name: string
  readonly version?: string
  readonly url: string
  readonly sha256?: string
  readonly size?: number
  /** Source repository advertised by the registry (node artifacts only). */
  readonly sourceUrl?: string
  readonly displayName?: string
  readonly nodeType?: string
  /** Present when the registry pins a node artifact to a source revision. */
  readonly source?: RegistrySource
  readonly sourceStatus?: string
  readonly forgeVersion?: number
}

/** Summary row returned by registry search. */
export interface RegistrySkillSummary {
  readonly name: string
  readonly version?: string
  readonly description: string
  readonly profiles: readonly string[]
  readonly tags: readonly string[]
}

/** One published version row from /v1/skills/{name}/versions. */
export interface SkillVersionInfo {
  readonly version: string
  readonly sha256?: string
  readonly description?: string
  readonly state?: string
  readonly forgeVersion?: number
}

export interface SkillVersionList {
  readonly name: string
  readonly currentVersion?: string
  readonly versions: readonly SkillVersionInfo[]
}

export const DEFAULT_REGISTRY_URL = 'https://paos-resource-platform.dev.x-era.com'

export interface RegistryOptions {
  readonly baseUrl?: string | undefined
  readonly timeoutMs?: number
  /** Explicit bearer token; otherwise `tokenEnv` or DSH_FORGE_REGISTRY_TOKEN. */
  readonly token?: string | undefined
  readonly tokenEnv?: string | undefined
}

/**
 * Minimal anonymous client for the Forge resource registry.
 *
 * Only the four endpoints the manager needs are implemented: skill search,
 * skill resolve, node resolve and node download (done by the installer).
 */
export class ForgeRegistryClient {
  readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly token: string | undefined

  constructor(options: RegistryOptions = {}) {
    const configured = options.baseUrl ?? process.env['DSH_FORGE_REGISTRY_URL'] ?? DEFAULT_REGISTRY_URL
    this.baseUrl = configured.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 20000
    const envName = options.tokenEnv ?? 'DSH_FORGE_REGISTRY_TOKEN'
    this.token = options.token ?? process.env[envName] ?? undefined
  }

  /** Search the registry; an empty query lists everything. */
  async search(query = ''): Promise<RegistrySkillSummary[]> {
    const suffix = query.length === 0 ? '' : `?q=${encodeURIComponent(query)}`
    const value = await this.get(`/v1/skills${suffix}`)
    const items = Array.isArray(value) ? value : (value as { items?: unknown }).items
    if (!Array.isArray(items)) {
      throw new ForgeError('FORGE_REGISTRY_UNAVAILABLE', 'registry search response has no item list')
    }
    return items.map(item => {
      const record = item as Record<string, unknown>
      const profiles = Array.isArray(record['profiles'])
        ? (record['profiles'] as Array<Record<string, unknown>>).map(profile => String(profile['id'] ?? ''))
        : []
      return {
        name: String(record['name'] ?? ''),
        version: typeof record['version'] === 'string' ? record['version'] : undefined,
        description: String(record['description'] ?? ''),
        profiles,
        tags: Array.isArray(record['tags']) ? (record['tags'] as string[]) : [],
      }
    }).filter(summary => summary.name.length > 0)
  }

  /** Resolve a skill artifact; pass version to pin a published revision. */
  async skill(name: string, version?: string): Promise<RegistryArtifact> {
    const suffix = version === undefined ? '' : `?version=${encodeURIComponent(version)}`
    return artifactFrom(await this.get(`/v1/skills/${encodeURIComponent(name)}${suffix}`), name)
  }

  /** Every published version of one skill, plus the current one. */
  async skillVersions(name: string): Promise<SkillVersionList> {
    const value = await this.get(`/v1/skills/${encodeURIComponent(name)}/versions`) as Record<string, unknown>
    const items = Array.isArray(value['items']) ? value['items'] as Array<Record<string, unknown>> : []
    return {
      name: typeof value['name'] === 'string' ? value['name'] : name,
      ...(typeof value['current_version'] === 'string' ? { currentVersion: value['current_version'] } : {}),
      versions: items.map(item => ({
        version: String(item['version'] ?? ''),
        ...(typeof item['sha256'] === 'string' ? { sha256: item['sha256'] } : {}),
        ...(typeof item['description'] === 'string' ? { description: item['description'] } : {}),
        ...(typeof item['state'] === 'string' ? { state: item['state'] } : {}),
        ...(typeof item['forge_version'] === 'number' ? { forgeVersion: item['forge_version'] } : {}),
      })).filter(item => item.version.length > 0),
    }
  }

  /** Resolve one locked node artifact. */
  async node(artifactId: string): Promise<RegistryArtifact> {
    return artifactFrom(await this.get(`/v1/forge-nodes/${encodeURIComponent(artifactId)}`), artifactId)
  }

  private async get(path: string): Promise<unknown> {
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          accept: 'application/json',
          ...(this.token === undefined ? {} : { authorization: `Bearer ${this.token}` }),
        },
      })
    } catch (error) {
      throw new ForgeError('FORGE_REGISTRY_UNAVAILABLE', `${this.baseUrl}${path}: ${(error as Error).message}`)
    }
    if (!response.ok) {
      throw new ForgeError('FORGE_REGISTRY_UNAVAILABLE', `${this.baseUrl}${path}: HTTP ${response.status}`)
    }
    return response.json()
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sourceFrom(raw: Record<string, unknown>): RegistrySource {
  const str = (key: string): string | undefined => (typeof raw[key] === 'string' ? raw[key] as string : undefined)
  return {
    ...(str('repository_url') === undefined ? {} : { repositoryUrl: str('repository_url') }),
    ...(str('ref') === undefined ? {} : { ref: str('ref') }),
    ...(str('ref_type') === undefined ? {} : { refType: str('ref_type') }),
    ...(str('commit_sha') === undefined ? {} : { commitSha: str('commit_sha') }),
    ...(str('path') === undefined ? {} : { path: str('path') }),
    ...(str('archive_url') === undefined ? {} : { archiveUrl: str('archive_url') }),
    ...(str('raw_base_url') === undefined ? {} : { rawBaseUrl: str('raw_base_url') }),
    ...(str('browse_url') === undefined ? {} : { browseUrl: str('browse_url') }),
    ...(typeof raw['verified_at'] === 'number' ? { verifiedAt: raw['verified_at'] as number } : {}),
  }
}

function artifactFrom(value: unknown, name: string): RegistryArtifact {
  const record = value as Record<string, unknown>
  const url = record['download_url'] ?? record['url']
  if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
    throw new ForgeError('FORGE_REGISTRY_UNAVAILABLE', `artifact ${name} has no download URL`)
  }
  return {
    name: typeof record['name'] === 'string' ? record['name'] : name,
    version: typeof record['version'] === 'string' ? record['version'] : undefined,
    url,
    sha256: typeof record['sha256'] === 'string' ? record['sha256'] : undefined,
    size: typeof record['size'] === 'number' ? record['size'] : undefined,
    ...(typeof record['github_url'] === 'string' ? { sourceUrl: record['github_url'] } : {}),
    ...(typeof record['display_name'] === 'string' ? { displayName: record['display_name'] } : {}),
    ...(typeof record['node_type'] === 'string' ? { nodeType: record['node_type'] } : {}),
    ...(typeof record['source_status'] === 'string' ? { sourceStatus: record['source_status'] } : {}),
    ...(typeof record['forge_version'] === 'number' ? { forgeVersion: record['forge_version'] } : {}),
    ...(isObject(record['source']) ? { source: sourceFrom(record['source'] as Record<string, unknown>) } : {}),
  }
}
