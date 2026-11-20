import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Environment override for the forge data root, mirroring the DSH home convention. */
export const FORGE_HOME_ENV = 'DSH_FORGE_HOME'

/** Environment override for the shared models root (defaults to `<home>/models`). */
export const FORGE_MODELS_ENV = 'DSH_FORGE_MODELS'

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

/**
 * Resolve the shared models root.
 *
 * Order: explicit config (`models.root`) → `$DSH_FORGE_MODELS` → `<home>/models`.
 * Relative paths are resolved against `home`.
 */
export function resolveForgeModelsRoot(
  home: string,
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicit !== undefined && explicit.length > 0) return resolve(home, expandHome(explicit))
  const override = env[FORGE_MODELS_ENV]
  if (override !== undefined && override.length > 0) return resolve(home, expandHome(override))
  return join(home, 'models')
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
  readonly models: string
  readonly runtime: string
  readonly nodes: string
  readonly logs: string
}

/** Derive every managed subdirectory from the root. */
export function forgePaths(home: string, modelsRoot?: string): ForgePaths {
  return {
    home,
    skills: join(home, 'skills'),
    models: resolveForgeModelsRoot(home, modelsRoot),
    runtime: join(home, 'runtime'),
    nodes: join(home, 'runtime', 'nodes'),
    logs: join(home, 'runtime', 'logs'),
  }
}
