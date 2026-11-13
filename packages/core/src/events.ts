import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Append-only JSONL event log for operational facts (installs, runtime
 * lifecycle, tool calls, doctor runs).
 *
 * Logging is best-effort: a write failure must never break an install or a
 * running skill, so errors are swallowed after the first attempt.
 */
export class EventLog {
  constructor(
    readonly path: string,
    private readonly enabled = true,
  ) {}

  async append(event: string, fields: Record<string, unknown> = {}): Promise<void> {
    if (!this.enabled) return
    try {
      await mkdir(dirname(this.path), { recursive: true })
      const row = { ts: new Date().toISOString(), event, ...fields }
      await appendFile(this.path, `${JSON.stringify(row)}\n`, { mode: 0o600 })
    } catch {
      // operational logging must not fail the operation
    }
  }
}
