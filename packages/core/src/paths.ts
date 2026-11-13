import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Environment override for the forge data root, mirroring the DSH home convention. */
export const FORGE_HOME_ENV = 'DSH_FORGE_HOME'

/**
 * Resolve the forge data root.
 *
 * Order: explicit config → `$DSH_FORGE_HOME` → `$DSH_HOME/forge` → `~/.dsh/forge`.
 */
export function resolveForgeHome(explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return resolve(expandHome(explicit))
  const override = process.env[FORGE_HOME_ENV]
  if (override !== undefined && override.length > 0) return resolve(expandHome(override))
  const dshHome = process.env['DSH_HOME']
  if (dshHome !== undefined && dshHome.length > 0) return join(resolve(expandHome(dshHome)), 'forge')
  return join(homedir(), '.dsh', 'forge')
}

/** Expand a leading `~` so config values behave like shell paths. */
export function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/')) return join(homedir(), value.slice(2))
  return value
}

/** Layout of the forge data root. */
export interface ForgePaths {
  readonly home: string
  readonly skills: string
  readonly runtime: string
  readonly nodes: string
  readonly logs: string
}

/** Derive every managed subdirectory from the root. */
export function forgePaths(home: string): ForgePaths {
  return {
    home,
    skills: join(home, 'skills'),
    runtime: join(home, 'runtime'),
    nodes: join(home, 'runtime', 'nodes'),
    logs: join(home, 'runtime', 'logs'),
  }
}
