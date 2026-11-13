import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { ForgeError } from './errors.js'

export type JobState = 'running' | 'succeeded' | 'failed' | 'cancelled'

export interface JobProgress {
  readonly phase: string
  readonly downloadedBytes?: number
  readonly totalBytes?: number
}

export interface JobRecord {
  readonly id: string
  readonly kind: string
  readonly skill: string
  state: JobState
  phase: string
  downloadedBytes?: number
  totalBytes?: number
  readonly startedAt: string
  finishedAt?: string
  error?: string
  result?: unknown
}

export interface JobContext {
  readonly signal: AbortSignal
  progress(update: JobProgress): void
}

/**
 * In-process job runner with on-disk records, for work that outlives one turn
 * (a GB-scale download cannot block a model reply).
 */
export class JobRunner {
  private readonly jobs = new Map<string, JobRecord>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly writes = new Map<string, Promise<void>>()
  private readonly completions = new Map<string, Promise<void>>()

  constructor(private readonly root: string) {}

  /** Start a job; the returned record is live-updated and persisted. */
  start(kind: string, skill: string, task: (context: JobContext) => Promise<unknown>): JobRecord {
    const id = `${kind}-${randomUUID().slice(0, 8)}`
    const record: JobRecord = {
      id,
      kind,
      skill,
      state: 'running',
      phase: 'starting',
      startedAt: new Date().toISOString(),
    }
    this.jobs.set(id, record)
    const controller = new AbortController()
    this.controllers.set(id, controller)
    void this.persist(record)
    let settle!: () => void
    this.completions.set(id, new Promise<void>(resolveDone => { settle = resolveDone }))
    void (async () => {
      try {
        const result = await task({
          signal: controller.signal,
          progress: update => {
            record.phase = update.phase
            if (update.downloadedBytes !== undefined) record.downloadedBytes = update.downloadedBytes
            if (update.totalBytes !== undefined) record.totalBytes = update.totalBytes
            void this.persist(record)
          },
        })
        if (controller.signal.aborted) {
          record.state = 'cancelled'
          record.phase = 'cancelled'
        } else {
          record.state = 'succeeded'
          record.phase = 'done'
          record.result = result
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (controller.signal.aborted || message.includes('FORGE_CANCELLED')) {
          record.state = 'cancelled'
          record.phase = 'cancelled'
        } else {
          record.state = 'failed'
          record.phase = 'failed'
          record.error = message
        }
      } finally {
        record.finishedAt = new Date().toISOString()
        this.controllers.delete(id)
        await this.persist(record)
        settle()
      }
    })()
    return record
  }

  /** Wait until the job settles (including its final record write). */
  async wait(id: string): Promise<JobRecord | undefined> {
    const pending = this.completions.get(id)
    if (pending !== undefined) await pending
    return this.get(id)
  }

  /** Read one job (memory first, then disk after a restart). */
  async get(id: string): Promise<JobRecord | undefined> {
    const live = this.jobs.get(id)
    if (live !== undefined) return { ...live }
    try {
      return JSON.parse(await readFile(join(this.root, `${id}.json`), 'utf8')) as JobRecord
    } catch {
      return undefined
    }
  }

  /** Recent jobs, newest first. */
  async list(limit = 20): Promise<JobRecord[]> {
    let names: string[] = []
    try {
      names = (await readdir(this.root)).filter(name => name.endsWith('.json'))
    } catch {
      names = []
    }
    const records: JobRecord[] = []
    for (const name of names) {
      const record = await this.get(name.slice(0, -'.json'.length))
      if (record !== undefined) records.push(record)
    }
    for (const live of this.jobs.values()) {
      if (!records.some(record => record.id === live.id)) records.push({ ...live })
    }
    return records.sort((left, right) => right.startedAt.localeCompare(left.startedAt)).slice(0, limit)
  }

  /** Request cancellation; the task observes the aborted signal. */
  cancel(id: string): boolean {
    const controller = this.controllers.get(id)
    if (controller === undefined) return false
    controller.abort(new ForgeError('FORGE_CANCELLED', 'cancelled by request'))
    return true
  }

  private async persist(record: JobRecord): Promise<void> {
    const previous = this.writes.get(record.id) ?? Promise.resolve()
    const next = previous.then(async () => {
      await mkdir(this.root, { recursive: true })
      const target = join(this.root, `${record.id}.json`)
      const temp = `${target}.tmp-${process.pid}`
      await writeFile(temp, JSON.stringify({ ...record }, null, 2))
      await rename(temp, target)
    }).catch(() => undefined)
    this.writes.set(record.id, next)
    await next
  }
}
