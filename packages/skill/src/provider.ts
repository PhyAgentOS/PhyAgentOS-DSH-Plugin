import type { SkillCandidate, SkillDefinition, SkillProvider } from '@deepseek-ai/dsh-skill'
import { ForgeCatalog, type ForgeSkillEntry } from '@xera/forge-core'

/** Rank between `custom` (300) and `user-dsh` (400): user-level, but outranks nothing project-level. */
export const FORGE_SKILL_RANK = 450
export const FORGE_PROVIDER_NAME = 'forge'
export const FORGE_SKILL_SOURCE = 'forge'

export interface ForgeProviderOptions {
  readonly catalogs: readonly ForgeCatalog[]
}

/**
 * Build a skill provider over the forge roots.
 *
 * The provider does not cache: the registry invalidates it when the manager
 * reports a directory change, and every `list()` re-reads the manifests.
 */
export function createForgeProvider(options: ForgeProviderOptions): SkillProvider {
  return {
    name: FORGE_PROVIDER_NAME,
    async list(): Promise<readonly SkillCandidate[]> {
      const seen = new Set<string>()
      const candidates: SkillCandidate[] = []
      for (const catalog of options.catalogs) {
        const { skills } = await catalog.list()
        for (const entry of skills) {
          if (seen.has(entry.name)) continue
          seen.add(entry.name)
          candidates.push(toCandidate(entry))
        }
      }
      return candidates
    },
    async get(candidate: SkillCandidate): Promise<SkillDefinition | undefined> {
      const locator = candidate.locator as { name?: unknown } | undefined
      const name = typeof locator?.name === 'string' ? locator.name : undefined
      if (name === undefined) return undefined
      for (const catalog of options.catalogs) {
        const content = await catalog.readDocument(name)
        if (content === undefined) continue
        const entry = await catalog.load(name)
        if (entry === undefined) continue
        return toDefinition(entry, content)
      }
      return undefined
    },
  }
}

function toCandidate(entry: ForgeSkillEntry): SkillCandidate {
  const { manifest } = entry
  return {
    name: manifest.name,
    description: manifest.description,
    path: entry.dir,
    invocation: { modelInvocable: true, userInvocable: true },
    source: FORGE_SKILL_SOURCE,
    provider: FORGE_PROVIDER_NAME,
    resourceBase: { kind: 'directory', path: entry.dir },
    rank: FORGE_SKILL_RANK,
    locator: { name: manifest.name },
    metadata: forgeMetadata(entry),
  }
}

function toDefinition(entry: ForgeSkillEntry, content: string): SkillDefinition {
  const { manifest } = entry
  return {
    name: manifest.name,
    description: manifest.description,
    path: entry.dir,
    invocation: { modelInvocable: true, userInvocable: true },
    source: FORGE_SKILL_SOURCE,
    provider: FORGE_PROVIDER_NAME,
    resourceBase: { kind: 'directory', path: entry.dir },
    content,
    metadata: forgeMetadata(entry),
  }
}

function forgeMetadata(entry: ForgeSkillEntry): Readonly<Record<string, unknown>> {
  const { manifest } = entry
  return {
    forge: {
      version: manifest.version,
      forgeVersion: manifest.forgeVersion,
      profiles: Object.keys(manifest.profiles),
      ...(manifest.gatewayUrl === undefined ? {} : { gatewayUrl: manifest.gatewayUrl }),
    },
  }
}
