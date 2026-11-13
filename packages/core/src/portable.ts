import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import type { ForgeSkillEntry } from './catalog.js'
import { ForgeError } from './errors.js'

export interface PortableExport {
  readonly path: string
  readonly skill: string
  readonly profiles: readonly string[]
}

/**
 * Export an installed skill as a portable `SKILL.md` directory.
 *
 * Forge bundles keep metadata in `skill.yaml` and their `SKILL.md` has no
 * frontmatter; hosts such as DSH's skill-filesystem or Claude Code require it.
 * The export synthesizes the frontmatter, prepends the tool-calling convention,
 * and leaves the authored body untouched.
 */
export async function exportPortableSkill(entry: ForgeSkillEntry, outDir: string): Promise<PortableExport> {
  const body = await readFile(join(entry.dir, entry.manifest.skillDocument), 'utf8').catch(() => undefined)
  if (body === undefined) {
    throw new ForgeError('FORGE_SKILL_DOC_MISSING', `${entry.name} has no ${entry.manifest.skillDocument}`)
  }
  const profiles = Object.keys(entry.manifest.profiles)
  const frontmatter = {
    name: entry.name,
    description: entry.manifest.description,
    ...(profiles.length === 0 ? {} : { whenToUse: `Use when the task needs the ${entry.name} capability.` }),
    metadata: {
      forge: {
        version: entry.manifest.version,
        profiles,
        ...(entry.manifest.gatewayUrl === undefined ? {} : { gatewayUrl: entry.manifest.gatewayUrl }),
      },
    },
  }
  const preamble = [
    '> Exported from a Forge bundle by `forge skill export`.',
    '> Tools are invoked with `forge_tool_call(tool_id, arguments)`; use the ids from the manifest below.',
    `> Profiles: ${profiles.join(', ') || '(none)'}.`,
    '',
  ].join('\n')
  const document = `---\n${stringifyYaml(frontmatter)}---\n\n${preamble}\n${body}`

  const target = join(outDir, entry.name)
  await mkdir(join(target, 'profiles'), { recursive: true })
  await writeFile(join(target, 'SKILL.md'), document)
  await cp(join(entry.dir, 'skill.yaml'), join(target, 'skill.yaml'))
  for (const profile of Object.values(entry.manifest.profiles)) {
    const source = join(entry.dir, 'profiles', profile.id)
    await cp(source, join(target, 'profiles', profile.id), { recursive: true }).catch(() => undefined)
  }

  // Fail loudly rather than emitting a document other hosts will silently drop.
  const parsed = parseYaml(document.split('---')[1] ?? '')
  if (typeof parsed?.name !== 'string' || typeof parsed?.description !== 'string') {
    throw new ForgeError('FORGE_EXPORT_INVALID', 'exported frontmatter is missing name/description')
  }
  return { path: target, skill: entry.name, profiles }
}
