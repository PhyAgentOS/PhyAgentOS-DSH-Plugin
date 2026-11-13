import type { IncomingMessage } from 'node:http'

import { DshProfileStore, ForgeError, SkillFileStore } from '@xera/forge-core'

/** Everything the configuration API needs; both transports share it. */
export interface ApiDeps {
  readonly profiles: DshProfileStore
  readonly files: SkillFileStore
  readonly currentProfile?: string | undefined
}

export interface ApiResult {
  readonly status: number
  readonly body: unknown
}

/**
 * Route one `/forge/api/*` request.
 *
 * Same-origin under the DSH web server and loopback on the standalone server,
 * so every call path shares these validations.
 */
export async function handleApi(
  method: string,
  url: URL,
  deps: ApiDeps,
  readBody: () => Promise<Record<string, unknown>>,
): Promise<ApiResult> {
  const suffix = url.pathname.replace(/^\/forge\/api/, '').replace(/^\/api/, '')

  if (suffix === '/profiles' && method === 'GET') {
    return { status: 200, body: { ok: true, profiles: await deps.profiles.listProfiles(), current: deps.currentProfile ?? null } }
  }

  if (suffix === '/config' && method === 'GET') {
    const profile = url.searchParams.get('profile') ?? deps.currentProfile
    if (profile === null || profile === undefined) return { status: 400, body: { ok: false, error: 'profile is required' } }
    return { status: 200, body: { ok: true, ...await deps.profiles.read(profile) } }
  }

  if (suffix === '/config' && method === 'PUT') {
    const body = await readBody()
    const profile = typeof body['profile'] === 'string' ? body['profile'] : undefined
    if (profile === undefined) return { status: 400, body: { ok: false, error: 'profile is required' } }
    try {
      return { status: 200, body: { ok: true, ...await deps.profiles.write(profile, body['config']) } }
    } catch (error) {
      return { status: 400, body: { ok: false, error: describe(error) } }
    }
  }

  if (suffix === '/backups' && method === 'GET') {
    const profile = url.searchParams.get('profile') ?? deps.currentProfile
    if (profile === null || profile === undefined) return { status: 400, body: { ok: false, error: 'profile is required' } }
    try {
      return { status: 200, body: { ok: true, profile, backups: await deps.profiles.listBackups(profile) } }
    } catch (error) {
      return { status: 400, body: { ok: false, error: describe(error) } }
    }
  }

  if (suffix === '/restore-backup' && method === 'POST') {
    const body = await readBody()
    const profile = body['profile']
    const backup = body['backup']
    if (typeof profile !== 'string' || typeof backup !== 'string') {
      return { status: 400, body: { ok: false, error: 'profile and backup are required' } }
    }
    try {
      return { status: 200, body: { ok: true, ...await deps.profiles.restoreBackup(profile, backup) } }
    } catch (error) {
      return { status: 400, body: { ok: false, error: describe(error) } }
    }
  }

  if (suffix === '/skills' && method === 'GET') {
    return { status: 200, body: { ok: true, skills: await deps.files.tree() } }
  }

  if (suffix === '/skill-file' && method === 'GET') {
    const skill = url.searchParams.get('skill')
    const profile = url.searchParams.get('profile')
    const file = url.searchParams.get('file')
    if (skill === null || profile === null || file === null) {
      return { status: 400, body: { ok: false, error: 'skill, profile and file are required' } }
    }
    try {
      const content = await deps.files.read(skill, profile, file)
      return { status: 200, body: { ok: true, content, path: `${skill}/profiles/${profile}/${file}` } }
    } catch (error) {
      return { status: 400, body: { ok: false, error: describe(error) } }
    }
  }

  if (suffix === '/skill-file' && method === 'PUT') {
    const body = await readBody()
    const skill = body['skill']
    const profile = body['profile']
    const file = body['file']
    const content = body['content']
    if (typeof skill !== 'string' || typeof profile !== 'string' || typeof file !== 'string' || typeof content !== 'string') {
      return { status: 400, body: { ok: false, error: 'skill, profile, file and content are required' } }
    }
    try {
      return { status: 200, body: { ok: true, ...await deps.files.write(skill, profile, file, content) } }
    } catch (error) {
      return { status: 400, body: { ok: false, error: describe(error) } }
    }
  }

  return { status: 404, body: { ok: false, error: `no route for ${method} ${url.pathname}` } }
}

function describe(error: unknown): string {
  if (error instanceof ForgeError) return `${error.code}: ${error.message}`
  return error instanceof Error ? error.message : String(error)
}

/** Read a JSON object body with a 2 MiB cap. */
export async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > 2 * 1024 * 1024) throw new ForgeError('FORGE_FILE_INVALID', 'request body too large')
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ForgeError('FORGE_FILE_INVALID', 'request body must be a JSON object')
    }
    return value as Record<string, unknown>
  } catch (error) {
    if (error instanceof ForgeError) throw error
    throw new ForgeError('FORGE_FILE_INVALID', `invalid JSON: ${(error as Error).message}`)
  }
}
