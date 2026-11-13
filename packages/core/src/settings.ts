import { copyFile, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'

import { ForgeError } from './errors.js'

/** Row id the bundle inserts; the UI edits the config of exactly this row. */
export const FORGE_ROW_ID = 'forge-skill'

/** The forge plugin row config as edited by the UI. */
export interface ForgeRowConfig {
  home?: string
  skills?: { roots?: string[]; watch?: boolean }
  registry?: { url?: string; timeoutMs?: number; token?: string; tokenEnv?: string }
  runtime?: { dora?: string; dora1?: string; startTimeoutMs?: number }
  gateway?: { callTimeoutMs?: number }
  ui?: { port?: number; enabled?: boolean }
}

export interface ForgeRowSnapshot {
  readonly profile: string
  readonly path: string
  readonly rowExists: boolean
  readonly config: ForgeRowConfig
  readonly raw: string
}

export interface ForgeBackup {
  readonly file: string
  readonly at: string
  readonly size: number
}

export interface DshProfileStoreOptions {
  /** Profiles root; defaults to `$DSH_HOME/profiles` or `~/.dsh/profiles`. */
  readonly profilesRoot?: string | undefined
}

/**
 * Read and write the forge row config inside a DSH profile patch file.
 *
 * Edits go to `<profile>/cordis.patch.yml` (the user layer), never to a bundle.
 * YAML documents are edited through the CST so unrelated rows and comments keep
 * their formatting; the previous file is copied aside before each write.
 */
export class DshProfileStore {
  readonly root: string

  constructor(options: DshProfileStoreOptions = {}) {
    const dshHome = process.env['DSH_HOME']
    this.root = options.profilesRoot
      ?? (dshHome === undefined || dshHome.length === 0
        ? join(homedir(), '.dsh', 'profiles')
        : join(resolve(dshHome), 'profiles'))
  }

  /** Profiles that look like a DSH profile (they carry a package.json). */
  async listProfiles(): Promise<string[]> {
    let entries
    try {
      entries = await readdir(this.root, { withFileTypes: true })
    } catch {
      return []
    }
    const names: string[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      try {
        await stat(join(this.root, entry.name, 'package.json'))
        names.push(entry.name)
      } catch {
        // not a profile
      }
    }
    return names.sort()
  }

  /** Read the current row config for one profile. */
  async read(profile: string): Promise<ForgeRowSnapshot> {
    const path = this.patchPath(profile)
    const raw = await readFile(path, 'utf8').catch(() => '')
    const doc = parseDocument(raw.length === 0 ? '[]\n' : raw)
    const row = findRow(doc.contents)
    const node = row?.get('config') as { toJSON?: () => unknown } | undefined
    const config = (node?.toJSON?.() ?? {}) as ForgeRowConfig
    return { profile, path, rowExists: row !== undefined, config, raw }
  }

  /** Validate and write the row config, returning the backup path. */
  async write(profile: string, config: unknown): Promise<{ path: string; backup?: string }> {
    const normalized = validateConfig(config)
    const path = this.patchPath(profile)
    const raw = await readFile(path, 'utf8').catch(() => undefined)
    const doc = parseDocument(raw ?? '[]\n')
    if (!isSeq(doc.contents)) {
      throw new ForgeError('FORGE_CONFIG_INVALID', `${path} does not contain a top-level list`)
    }
    const seq = doc.contents as YAMLSeq
    if (seq.flow === true) seq.flow = false
    let row = findRow(seq)
    if (row === undefined) {
      const node = doc.createNode({ id: FORGE_ROW_ID, config: normalized })
      seq.add(node)
    } else {
      row.set('config', doc.createNode(normalized))
      if (row.flow === true) row.flow = false
    }
    const text = String(doc)

    let backup: string | undefined
    if (raw !== undefined) {
      backup = `${path}.bak-${stamp()}`
      await copyFile(path, backup)
    }
    const temp = `${path}.tmp-${process.pid}`
    await writeFile(temp, text, { mode: 0o600 })
    await rename(temp, path)
    return { path, ...(backup === undefined ? {} : { backup }) }
  }

  /** Backups created by this store, newest first. */
  async listBackups(profile: string): Promise<ForgeBackup[]> {
    const path = this.patchPath(profile)
    const dir = path.slice(0, path.lastIndexOf('/'))
    const base = path.slice(path.lastIndexOf('/') + 1)
    let names: string[] = []
    try {
      names = (await readdir(dir)).filter(name => name.startsWith(`${base}.bak-`))
    } catch {
      return []
    }
    const backups: ForgeBackup[] = []
    for (const name of names) {
      try {
        const info = await stat(join(dir, name))
        backups.push({ file: name, at: new Date(info.mtimeMs).toISOString(), size: info.size })
      } catch {
        // raced with removal
      }
    }
    return backups.sort((left, right) => right.at.localeCompare(left.at))
  }

  /** Restore one backup, keeping the current file as another backup first. */
  async restoreBackup(profile: string, file: string): Promise<{ path: string; restored: string; previous?: string }> {
    const path = this.patchPath(profile)
    if (!/^[A-Za-z0-9._-]+\.bak-[0-9-]+$/.test(file)) {
      throw new ForgeError('FORGE_CONFIG_INVALID', `invalid backup name "${file}"`)
    }
    if (!file.startsWith('cordis.patch.yml.bak-')) {
      throw new ForgeError('FORGE_CONFIG_INVALID', 'backup does not belong to this profile')
    }
    const source = join(path.slice(0, path.lastIndexOf('/')), file)
    const content = await readFile(source, 'utf8')
    let previous: string | undefined
    try {
      await stat(path)
      previous = `${path}.bak-${stamp()}`
      await copyFile(path, previous)
    } catch {
      previous = undefined
    }
    const temp = `${path}.tmp-${process.pid}`
    await writeFile(temp, content, { mode: 0o600 })
    await rename(temp, path)
    return { path, restored: file, ...(previous === undefined ? {} : { previous }) }
  }

  private patchPath(profile: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
      throw new ForgeError('FORGE_CONFIG_INVALID', `invalid profile name "${profile}"`)
    }
    return join(this.root, profile, 'cordis.patch.yml')
  }
}

function findRow(contents: unknown): YAMLMap | undefined {
  if (!isSeq(contents)) return undefined
  for (const item of contents.items) {
    if (isMap(item) && item.get('id') === FORGE_ROW_ID) return item
  }
  return undefined
}

/** Reject unknown keys and wrong value types before anything is written. */
export function validateConfig(input: unknown): ForgeRowConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new ForgeError('FORGE_CONFIG_INVALID', 'config must be an object')
  }
  const source = input as Record<string, unknown>
  const config: ForgeRowConfig = {}
  const string = (value: unknown, key: string): string => {
    if (typeof value !== 'string') throw new ForgeError('FORGE_CONFIG_INVALID', `${key} must be a string`)
    return value
  }
  const number = (value: unknown, key: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new ForgeError('FORGE_CONFIG_INVALID', `${key} must be a non-negative number`)
    }
    return value
  }
  const boolean = (value: unknown, key: string): boolean => {
    if (typeof value !== 'boolean') throw new ForgeError('FORGE_CONFIG_INVALID', `${key} must be a boolean`)
    return value
  }
  const record = (value: unknown, key: string): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ForgeError('FORGE_CONFIG_INVALID', `${key} must be an object`)
    }
    return value as Record<string, unknown>
  }

  const allowed = new Set(['home', 'skills', 'registry', 'runtime', 'gateway', 'ui'])
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new ForgeError('FORGE_CONFIG_INVALID', `unknown config key "${key}"`)
  }
  if (source['home'] !== undefined) config.home = string(source['home'], 'home')
  if (source['skills'] !== undefined) {
    const skills = record(source['skills'], 'skills')
    for (const key of Object.keys(skills)) if (key !== 'roots' && key !== 'watch') throw new ForgeError('FORGE_CONFIG_INVALID', `unknown key skills.${key}`)
    config.skills = {}
    if (skills['roots'] !== undefined) {
      if (!Array.isArray(skills['roots']) || skills['roots'].some(item => typeof item !== 'string')) {
        throw new ForgeError('FORGE_CONFIG_INVALID', 'skills.roots must be an array of strings')
      }
      config.skills.roots = skills['roots'] as string[]
    }
    if (skills['watch'] !== undefined) config.skills.watch = boolean(skills['watch'], 'skills.watch')
  }
  if (source['registry'] !== undefined) {
    const registry = record(source['registry'], 'registry')
    for (const key of Object.keys(registry)) if (!['url', 'timeoutMs', 'token', 'tokenEnv'].includes(key)) throw new ForgeError('FORGE_CONFIG_INVALID', `unknown key registry.${key}`)
    config.registry = {}
    if (registry['url'] !== undefined) config.registry.url = string(registry['url'], 'registry.url')
    if (registry['timeoutMs'] !== undefined) config.registry.timeoutMs = number(registry['timeoutMs'], 'registry.timeoutMs')
    if (registry['token'] !== undefined) config.registry.token = string(registry['token'], 'registry.token')
    if (registry['tokenEnv'] !== undefined) config.registry.tokenEnv = string(registry['tokenEnv'], 'registry.tokenEnv')
  }
  if (source['runtime'] !== undefined) {
    const runtime = record(source['runtime'], 'runtime')
    for (const key of Object.keys(runtime)) if (!['dora', 'dora1', 'startTimeoutMs'].includes(key)) throw new ForgeError('FORGE_CONFIG_INVALID', `unknown key runtime.${key}`)
    config.runtime = {}
    if (runtime['dora'] !== undefined) config.runtime.dora = string(runtime['dora'], 'runtime.dora')
    if (runtime['dora1'] !== undefined) config.runtime.dora1 = string(runtime['dora1'], 'runtime.dora1')
    if (runtime['startTimeoutMs'] !== undefined) config.runtime.startTimeoutMs = number(runtime['startTimeoutMs'], 'runtime.startTimeoutMs')
  }
  if (source['gateway'] !== undefined) {
    const gateway = record(source['gateway'], 'gateway')
    for (const key of Object.keys(gateway)) if (key !== 'callTimeoutMs') throw new ForgeError('FORGE_CONFIG_INVALID', `unknown key gateway.${key}`)
    config.gateway = {}
    if (gateway['callTimeoutMs'] !== undefined) config.gateway.callTimeoutMs = number(gateway['callTimeoutMs'], 'gateway.callTimeoutMs')
  }
  if (source['ui'] !== undefined) {
    const ui = record(source['ui'], 'ui')
    for (const key of Object.keys(ui)) if (key !== 'port' && key !== 'enabled') throw new ForgeError('FORGE_CONFIG_INVALID', `unknown key ui.${key}`)
    config.ui = {}
    if (ui['port'] !== undefined) config.ui.port = number(ui['port'], 'ui.port')
    if (ui['enabled'] !== undefined) config.ui.enabled = boolean(ui['enabled'], 'ui.enabled')
  }
  return config
}

let backupCounter = 0

function stamp(): string {
  const now = new Date()
  const pad = (value: number): string => String(value).padStart(2, '0')
  backupCounter += 1
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${String(now.getMilliseconds()).padStart(3, '0')}-${backupCounter}`
}
