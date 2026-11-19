/**
 * Forge platform generations this build can drive.
 *
 * One source of truth for the static catalog check, the runtime preflight and
 * the dora-binary dispatch: a bundle generation that is not listed here is
 * rejected everywhere, and one that is listed is accepted everywhere.
 */

/** Generations this build implements, oldest first. */
export const SUPPORTED_FORGE_VERSIONS = ['1', '2'] as const

/** One supported Forge platform generation. */
export type ForgeGeneration = (typeof SUPPORTED_FORGE_VERSIONS)[number]

/** Generation assumed when a manifest omits `forge_version`. */
export const DEFAULT_FORGE_VERSION: ForgeGeneration = '1'

/** Return whether a manifest value names a generation this build implements. */
export function isForgeGeneration(value: string): value is ForgeGeneration {
  return (SUPPORTED_FORGE_VERSIONS as readonly string[]).includes(value)
}

/** Human-readable contract for one generation, used by every diagnostic. */
export function forgeGenerationLabel(value: ForgeGeneration): string {
  return value === '2' ? 'Forge 2 (dora 1.x, forge-tool 2.x)' : 'Forge 1 (dora 0.4.1)'
}

/** Diagnostic for a manifest that names an unsupported generation. */
export function unsupportedForgeVersionDetail(value: string): string {
  const supported = SUPPORTED_FORGE_VERSIONS
    .map(generation => forgeGenerationLabel(generation))
    .join(', ')
  return `bundle targets Forge ${value}; this build implements ${supported}`
}