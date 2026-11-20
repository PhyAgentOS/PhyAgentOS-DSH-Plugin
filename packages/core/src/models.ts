import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join } from 'node:path'

import type { ForgeModelRequirement } from './manifest.js'

/** Reserved top-level entries inside `<modelsRoot>` that are not model ids. */
const RESERVED_ENTRIES = new Set(['cache', 'blobs', 'registry.json'])

/** Metadata file names skipped when computing primary weight files. */
const METADATA_FILES = new Set(['receipt.json', 'model.json', 'README.md', 'LICENSE', 'LICENSE.txt'])

/** Common weight file extensions, ordered by preference for primary file detection. */
const WEIGHT_EXTENSIONS = new Set([
  '.safetensors',
  '.pt',
  '.pth',
  '.ckpt',
  '.onnx',
  '.gguf',
  '.bin',
  '.engine',
  '.trt',
  '.weights',
])

/** Metadata persisted alongside a model revision in `receipt.json`. */
export interface ModelReceipt {
  readonly id?: string
  readonly revision?: string
  readonly filename?: string
  readonly sha256?: string
  readonly size?: number
  readonly source?: string
  readonly description?: string
  readonly tags?: readonly string[]
  readonly license?: string
  readonly installedAt?: string
}

/** One file inside a local model revision directory. */
export interface ModelFileEntry {
  readonly name: string
  readonly path: string
  readonly bytes: number
}

/** One installed model revision discovered under `<modelsRoot>`. */
export interface ModelEntry {
  readonly id: string
  readonly revision: string
  readonly dir: string
  /** Resolved weight file path when a primary file can be identified. */
  readonly primaryFile?: string
  readonly filename?: string
  readonly files: readonly ModelFileEntry[]
  readonly bytes: number
  readonly sha256?: string
  readonly source?: string
  readonly description?: string
  readonly tags: readonly string[]
  readonly license?: string
  readonly installedAt?: string
  readonly receiptExists: boolean
  readonly referencedBy: readonly string[]
}

/** Problem observed while scanning a model directory (never aborts listing). */
export interface ModelDiagnostic {
  readonly id: string
  readonly revision?: string
  readonly path: string
  readonly code: string
  readonly message: string
}

/** Search filter for local models. */
export interface ModelSearchQuery {
  /** Case-insensitive free text matched against id, revision, description, tags, files, source and referencing skills. */
  readonly query?: string | undefined
  /** Exact model id filter. */
  readonly id?: string | undefined
  /** Case-insensitive tag filter. */
  readonly tag?: string | undefined
  /** Filter to models referenced by one installed skill name. */
  readonly skill?: string | undefined
}

/** Result of listing or searching local models. */
export interface ModelSearchResult {
  readonly root: string
  readonly exists: boolean
  readonly count: number
  readonly totalBytes: number
  readonly models: readonly ModelEntry[]
  readonly diagnostics: readonly ModelDiagnostic[]
}

/** Detailed lookup result for one model id (and optional revision). */
export interface ModelInfoResult {
  readonly root: string
  readonly model: ModelEntry
  readonly revisions: readonly string[]
  readonly receipt?: ModelReceipt
}

/** Integrity check result for one local model revision. */
export interface ModelVerifyResult {
  readonly ok: boolean
  readonly id: string
  readonly revision: string
  readonly status: 'verified' | 'unverified' | 'mismatch' | 'missing'
  readonly path?: string
  readonly expectedSha256?: string
  readonly actualSha256?: string
  readonly detail: string
}

/** Resolution outcome for one `skill.yaml` `required_models` entry. */
export interface ModelRequirementStatus {
  readonly id: string
  readonly revision?: string
  readonly env?: string
  readonly optional: boolean
  readonly state: 'ready' | 'unverified' | 'mismatch' | 'missing'
  /** File path (when a weight file is identified) or revision directory. */
  readonly path?: string
  readonly detail: string
}

/**
 * Local store and search index for shared Forge model weights.
 *
 * Canonical layout:
 *   `<modelsRoot>/<model-id>/<revision>/`
 *     - `receipt.json` (optional metadata: filename, sha256, source, tags, description, license)
 *     - `<weight files>` (e.g. `sam3.pt`, `model.safetensors`, `config.json`)
 *
 * Also recognizes flat `<modelsRoot>/<model-id>/<weight-file>` drops under
 * `revision: "default"` so manually placed weights remain discoverable.
 */
export class ModelStore {
  constructor(readonly root: string) {}

  /** Scan every local model revision under `root`. Read-only; never creates directories. */
  async list(referencedBy: ReadonlyMap<string, readonly string[]> = new Map()): Promise<ModelSearchResult> {
    const rootInfo = await statSafe(this.root)
    if (rootInfo === undefined) {
      return { root: this.root, exists: false, count: 0, totalBytes: 0, models: [], diagnostics: [] }
    }
    if (!rootInfo.isDirectory()) {
      return {
        root: this.root,
        exists: false,
        count: 0,
        totalBytes: 0,
        models: [],
        diagnostics: [{
          id: '',
          path: this.root,
          code: 'FORGE_MODEL_ROOT_INVALID',
          message: `${this.root} exists but is not a directory`,
        }],
      }
    }

    const models: ModelEntry[] = []
    const diagnostics: ModelDiagnostic[] = []
    const idEntries = await readdirSafe(this.root)

    for (const idEntry of idEntries) {
      if (idEntry.name.startsWith('.') || RESERVED_ENTRIES.has(idEntry.name)) continue
      if (!idEntry.isDirectory()) continue

      const id = idEntry.name
      const modelDir = join(this.root, id)
      const children = await readdirSafe(modelDir)
      const revisionDirs = children.filter(child => !child.name.startsWith('.') && child.isDirectory())
      const directFiles = children.filter(child => !child.name.startsWith('.') && !child.isDirectory())

      if (revisionDirs.length > 0) {
        for (const revEntry of revisionDirs) {
          const scanned = await scanRevision(id, revEntry.name, join(modelDir, revEntry.name), referencedBy)
          models.push(scanned.entry)
          if (scanned.diagnostic !== undefined) diagnostics.push(scanned.diagnostic)
        }
      } else if (directFiles.length > 0) {
        const scanned = await scanRevision(id, 'default', modelDir, referencedBy)
        models.push(scanned.entry)
        if (scanned.diagnostic !== undefined) diagnostics.push(scanned.diagnostic)
      }
    }

    models.sort((left, right) => left.id.localeCompare(right.id) || left.revision.localeCompare(right.revision))
    const totalBytes = models.reduce((sum, item) => sum + item.bytes, 0)
    return {
      root: this.root,
      exists: true,
      count: models.length,
      totalBytes,
      models,
      diagnostics,
    }
  }

  /** Search local models by free-text query, id, tag or referencing skill. */
  async search(
    filter: ModelSearchQuery = {},
    referencedBy: ReadonlyMap<string, readonly string[]> = new Map(),
  ): Promise<ModelSearchResult> {
    const listing = await this.list(referencedBy)
    const idFilter = filter.id?.trim()
    const tagFilter = filter.tag?.trim().toLowerCase()
    const skillFilter = filter.skill?.trim()
    const tokens = (filter.query ?? '')
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(token => token.length > 0)

    const matched = listing.models.filter((entry) => {
      if (idFilter !== undefined && idFilter.length > 0 && entry.id !== idFilter) return false
      if (tagFilter !== undefined && tagFilter.length > 0) {
        if (!entry.tags.some(tag => tag.toLowerCase() === tagFilter)) return false
      }
      if (skillFilter !== undefined && skillFilter.length > 0) {
        if (!entry.referencedBy.includes(skillFilter)) return false
      }
      if (tokens.length === 0) return true
      const haystack = [
        entry.id,
        entry.revision,
        entry.filename ?? '',
        entry.description ?? '',
        entry.source ?? '',
        entry.license ?? '',
        ...entry.tags,
        ...entry.referencedBy,
        ...entry.files.map(file => file.name),
      ].join('\n').toLowerCase()
      return tokens.every(token => haystack.includes(token))
    })

    const totalBytes = matched.reduce((sum, item) => sum + item.bytes, 0)
    return {
      root: listing.root,
      exists: listing.exists,
      count: matched.length,
      totalBytes,
      models: matched,
      diagnostics: listing.diagnostics,
    }
  }

  /** Look up one model id (and optional revision), returning all available revisions too. */
  async info(
    id: string,
    revision?: string,
    referencedBy: ReadonlyMap<string, readonly string[]> = new Map(),
  ): Promise<ModelInfoResult | undefined> {
    const listing = await this.list(referencedBy)
    const candidates = listing.models.filter(entry => entry.id === id)
    if (candidates.length === 0) return undefined
    const selected = revision !== undefined && revision.length > 0
      ? candidates.find(entry => entry.revision === revision)
      : pickPreferredRevision(candidates)
    if (selected === undefined) return undefined
    const receipt = await readReceiptFile(join(selected.dir, 'receipt.json'))
    return {
      root: this.root,
      model: selected,
      revisions: candidates.map(entry => entry.revision),
      ...(receipt.receipt === undefined ? {} : { receipt: receipt.receipt }),
    }
  }

  /** Verify the primary weight file's actual SHA256 against `receipt.json`. */
  async verify(id: string, revision?: string): Promise<ModelVerifyResult> {
    const found = await this.info(id, revision)
    if (found === undefined) {
      return {
        ok: false,
        id,
        revision: revision ?? 'default',
        status: 'missing',
        detail: revision === undefined
          ? `model "${id}" is not installed under ${this.root}`
          : `model "${id}@${revision}" is not installed under ${this.root}`,
      }
    }
    const { model } = found
    const target = model.primaryFile
    if (target === undefined) {
      return {
        ok: false,
        id: model.id,
        revision: model.revision,
        status: 'missing',
        path: model.dir,
        detail: `${model.id}@${model.revision}: no weight file found in ${model.dir}`,
      }
    }
    const actualSha256 = await sha256File(target)
    const expectedSha256 = model.sha256?.toLowerCase()
    if (expectedSha256 === undefined) {
      return {
        ok: true,
        id: model.id,
        revision: model.revision,
        status: 'unverified',
        path: target,
        actualSha256,
        detail: `${model.id}@${model.revision}: present without pinned sha256 in receipt.json (actual ${actualSha256})`,
      }
    }
    if (actualSha256 !== expectedSha256) {
      return {
        ok: false,
        id: model.id,
        revision: model.revision,
        status: 'mismatch',
        path: target,
        expectedSha256,
        actualSha256,
        detail: `${model.id}@${model.revision}: digest ${actualSha256} does not match receipt ${expectedSha256}`,
      }
    }
    return {
      ok: true,
      id: model.id,
      revision: model.revision,
      status: 'verified',
      path: target,
      expectedSha256,
      actualSha256,
      detail: `${model.id}@${model.revision}: verified ${actualSha256}`,
    }
  }

  /** Resolve one `skill.yaml` `required_models` entry against local disk state (fast metadata check). */
  async resolveRequirement(requirement: ForgeModelRequirement): Promise<ModelRequirementStatus> {
    const optional = requirement.optional === true
    const found = await this.info(requirement.id, requirement.revision)
    if (found === undefined) {
      const label = requirement.revision === undefined ? requirement.id : `${requirement.id}@${requirement.revision}`
      return {
        id: requirement.id,
        ...(requirement.revision === undefined ? {} : { revision: requirement.revision }),
        ...(requirement.env === undefined ? {} : { env: requirement.env }),
        optional,
        state: 'missing',
        detail: `${label}: not installed under ${this.root}`,
      }
    }

    const { model } = found
    const targetPath = requirement.filename !== undefined
      ? join(model.dir, requirement.filename)
      : (model.primaryFile ?? model.dir)

    const targetInfo = await statSafe(targetPath)
    if (targetInfo === undefined) {
      return {
        id: requirement.id,
        revision: model.revision,
        ...(requirement.env === undefined ? {} : { env: requirement.env }),
        optional,
        state: 'missing',
        path: targetPath,
        detail: `${model.id}@${model.revision}: expected file ${requirement.filename ?? targetPath} is missing`,
      }
    }

    if (requirement.sha256 !== undefined) {
      const expected = requirement.sha256.toLowerCase()
      const recorded = model.sha256?.toLowerCase()
      if (recorded === undefined) {
        return {
          id: requirement.id,
          revision: model.revision,
          ...(requirement.env === undefined ? {} : { env: requirement.env }),
          optional,
          state: 'unverified',
          path: targetPath,
          detail: `${model.id}@${model.revision}: present at ${targetPath} without receipt.json digest`,
        }
      }
      if (recorded !== expected) {
        return {
          id: requirement.id,
          revision: model.revision,
          ...(requirement.env === undefined ? {} : { env: requirement.env }),
          optional,
          state: 'mismatch',
          path: targetPath,
          detail: `${model.id}@${model.revision}: receipt digest ${recorded} does not match required ${expected}`,
        }
      }
    }

    return {
      id: requirement.id,
      revision: model.revision,
      ...(requirement.env === undefined ? {} : { env: requirement.env }),
      optional,
      state: 'ready',
      path: targetPath,
      detail: `${model.id}@${model.revision}: ${targetPath}`,
    }
  }
}

async function scanRevision(
  id: string,
  revision: string,
  dir: string,
  referencedBy: ReadonlyMap<string, readonly string[]>,
): Promise<{ entry: ModelEntry; diagnostic?: ModelDiagnostic }> {
  const receiptPath = join(dir, 'receipt.json')
  const { exists: receiptExists, receipt, error } = await readReceiptFile(receiptPath)
  const files = await collectFiles(dir, dir)
  const bytes = files.reduce((sum, file) => sum + file.bytes, 0)

  const filename = receipt?.filename ?? detectPrimaryFilename(files)
  const primaryFile = filename !== undefined ? join(dir, filename) : undefined
  const refs = new Set<string>([
    ...(referencedBy.get(id) ?? []),
    ...(referencedBy.get(`${id}@${revision}`) ?? []),
  ])

  const entry: ModelEntry = {
    id,
    revision,
    dir,
    ...(primaryFile !== undefined && (await statSafe(primaryFile))?.isFile() ? { primaryFile } : {}),
    ...(filename === undefined ? {} : { filename }),
    files,
    bytes,
    ...(receipt?.sha256 === undefined ? {} : { sha256: receipt.sha256 }),
    ...(receipt?.source === undefined ? {} : { source: receipt.source }),
    ...(receipt?.description === undefined ? {} : { description: receipt.description }),
    tags: receipt?.tags ?? [],
    ...(receipt?.license === undefined ? {} : { license: receipt.license }),
    ...(receipt?.installedAt === undefined ? {} : { installedAt: receipt.installedAt }),
    receiptExists,
    referencedBy: [...refs].sort(),
  }

  if (error !== undefined) {
    return {
      entry,
      diagnostic: {
        id,
        revision,
        path: receiptPath,
        code: 'FORGE_MODEL_RECEIPT_INVALID',
        message: error,
      },
    }
  }
  return { entry }
}

function detectPrimaryFilename(files: readonly ModelFileEntry[]): string | undefined {
  const candidates = files.filter(file => !METADATA_FILES.has(file.name))
  if (candidates.length === 0) return undefined
  const weights = candidates
    .filter(file => WEIGHT_EXTENSIONS.has(extname(file.name).toLowerCase()))
    .sort((left, right) => right.bytes - left.bytes || left.name.localeCompare(right.name))
  if (weights.length > 0) return weights[0]?.name
  if (candidates.length === 1) return candidates[0]?.name
  return undefined
}

function pickPreferredRevision(candidates: readonly ModelEntry[]): ModelEntry | undefined {
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]
  return [...candidates].sort((left, right) => {
    const byDate = (right.installedAt ?? '').localeCompare(left.installedAt ?? '')
    if (byDate !== 0) return byDate
    return right.revision.localeCompare(left.revision)
  })[0]
}

async function readReceiptFile(
  path: string,
): Promise<{ exists: boolean; receipt?: ModelReceipt; error?: string }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false }
    return { exists: true, error: (error as Error).message }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return { exists: true, error: `invalid JSON in receipt.json: ${(error as Error).message}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { exists: true, error: 'receipt.json root must be a JSON object' }
  }
  const obj = parsed as Record<string, unknown>
  const str = (key: string): string | undefined => (typeof obj[key] === 'string' && (obj[key] as string).length > 0 ? obj[key] as string : undefined)
  const num = (key: string): number | undefined => (typeof obj[key] === 'number' && Number.isFinite(obj[key] as number) ? obj[key] as number : undefined)
  const tags = Array.isArray(obj['tags']) ? obj['tags'].filter((item): item is string => typeof item === 'string' && item.length > 0) : undefined
  const receipt: ModelReceipt = {
    ...(str('id') === undefined ? {} : { id: str('id') }),
    ...(str('revision') === undefined ? {} : { revision: str('revision') }),
    ...(str('filename') === undefined ? {} : { filename: str('filename') }),
    ...(str('sha256') === undefined ? {} : { sha256: str('sha256')!.toLowerCase() }),
    ...(num('size') === undefined ? {} : { size: num('size') }),
    ...(str('source') === undefined ? {} : { source: str('source') }),
    ...(str('description') === undefined ? {} : { description: str('description') }),
    ...(tags === undefined ? {} : { tags }),
    ...(str('license') === undefined ? {} : { license: str('license') }),
    ...(str('installedAt') === undefined ? {} : { installedAt: str('installedAt') }),
  }
  return { exists: true, receipt }
}

async function collectFiles(root: string, current: string): Promise<ModelFileEntry[]> {
  const results: ModelFileEntry[] = []
  for (const entry of await readdirSafe(current)) {
    if (entry.name.startsWith('.')) continue
    const full = join(current, entry.name)
    if (entry.isDirectory()) {
      results.push(...await collectFiles(root, full))
    } else {
      const info = await statSafe(full)
      if (info === undefined || !info.isFile()) continue
      const rel = full.slice(root.length + 1).replace(/\\/g, '/')
      results.push({ name: rel, path: full, bytes: info.size })
    }
  }
  return results.sort((left, right) => left.name.localeCompare(right.name))
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.on('error', rejectHash)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function readdirSafe(path: string) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch {
    return []
  }
}

async function statSafe(path: string) {
  try {
    return await stat(path)
  } catch {
    return undefined
  }
}
