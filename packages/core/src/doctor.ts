import type { ForgeCatalog, ForgeCheck } from './catalog.js'
import { ForgeToolClient } from './tool-client.js'
import type { SkillRuntimeManager, RuntimeState } from './runtime.js'
import { toolsForProfile } from './manifest.js'

export interface DiagnoseOptions {
  readonly catalog: ForgeCatalog
  readonly runtime?: SkillRuntimeManager | undefined
  readonly skill: string
  readonly profile?: string | undefined
}

export interface Diagnosis {
  readonly skill: string
  readonly profile?: string
  readonly ok: boolean
  readonly checks: readonly ForgeCheck[]
  readonly runtime?: RuntimeState
}

/**
 * Static plus runtime diagnosis for one skill.
 *
 * Static checks always run. Runtime checks run when a state exists, and add
 * gateway reachability plus required-tool coverage for the selected profile.
 */
export async function diagnoseSkill(options: DiagnoseOptions): Promise<Diagnosis> {
  const entry = await options.catalog.load(options.skill)
  if (entry === undefined) {
    return {
      skill: options.skill,
      ...(options.profile === undefined ? {} : { profile: options.profile }),
      ok: false,
      checks: [{ id: 'manifest', status: 'fail', detail: `skill "${options.skill}" is not installed` }],
    }
  }

  const inspection = await options.catalog.inspect(options.skill)
  const checks: ForgeCheck[] = [...(inspection?.checks ?? [])]

  const profileId = options.profile ?? Object.keys(entry.manifest.profiles)[0]
  if (profileId === undefined) {
    checks.push({ id: 'profile', status: 'fail', detail: 'manifest has no profile' })
    return { skill: options.skill, ok: false, checks }
  }
  checks.push({ id: 'profile', status: 'pass', detail: profileId })

  const runtime = await options.runtime?.status(options.skill)
  if (runtime !== undefined) {
    checks.push({
      id: 'runtime',
      status: runtime.status === 'healthy' ? 'pass' : runtime.status === 'failed' ? 'fail' : 'warn',
      detail: `${runtime.status} (${runtime.profile}, flow ${runtime.flow})`,
    })
    if (runtime.status === 'healthy') {
      const client = new ForgeToolClient(runtime.gatewayUrl)
      try {
        const tools = await client.tools()
        const required = toolsForProfile(entry.manifest, runtime.profile)
        const available = new Set(tools.map(tool => tool.toolId))
        const missing = required.filter(tool => !available.has(tool))
        checks.push({
          id: 'gateway.tools',
          status: missing.length === 0 ? 'pass' : 'fail',
          detail: missing.length === 0 ? `${available.size} tools exposed` : `missing: ${missing.join(', ')}`,
        })
      } catch (error) {
        checks.push({ id: 'gateway.tools', status: 'fail', detail: (error as Error).message })
      }
    }
  } else if (options.runtime !== undefined) {
    checks.push({ id: 'runtime', status: 'warn', detail: 'no runtime started' })
  }

  return {
    skill: options.skill,
    profile: profileId,
    ok: checks.every(check => check.status !== 'fail'),
    checks,
    ...(runtime === undefined ? {} : { runtime }),
  }
}
