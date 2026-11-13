import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ForgeError, type ForgeOperations, type GatewayTool } from '@x-era/forge-core'

export type DynamicMode = 'off' | 'whitelist' | 'all'

export interface DynamicOptions {
  readonly mode: DynamicMode
  readonly skills: readonly string[]
}

const objectOutput = {
  schema: { type: 'object', additionalProperties: true },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
}

/**
 * Optional typed tool surface: one DSH tool per Gateway ToolSpec.
 *
 * `forge_tool_call` stays the default; this only registers tools for the skills
 * an operator opted into. Registration is per running gateway and disposed when
 * that runtime stops, so a dead gateway never leaves stale tools behind.
 */
export class DynamicToolRegistry {
  private readonly disposers = new Map<string, Array<() => void>>()

  constructor(
    private readonly ctx: Context,
    private readonly operations: ForgeOperations,
    private readonly options: DynamicOptions,
  ) {}

  enabled(skill: string): boolean {
    if (this.options.mode === 'all') return true
    return this.options.mode === 'whitelist' && this.options.skills.includes(skill)
  }

  /** Reconcile the typed tools for one skill with its current gateway. */
  async refresh(skill: string): Promise<{ registered: string[]; skipped?: string }> {
    if (!this.enabled(skill)) return { registered: [], skipped: 'disabled' }
    const state = await this.operations.runtimeStatus(skill)
    if (state === null || state.status !== 'healthy') {
      this.dispose(skill)
      return { registered: [], skipped: 'no healthy runtime' }
    }
    const specs = await this.operations.gatewayTools(skill)
    this.dispose(skill)
    const registered: string[] = []
    const disposers: Array<() => void> = []
    const used = new Set<string>()
    for (const spec of specs) {
      const name = toolNameFor(skill, spec.toolId)
      if (used.has(name)) continue
      used.add(name)
      const definition = defineTool({
        name,
        description: `[${skill}] ${describeTool(spec)}`,
        parameters: jsonSchemaToParameters(spec.raw),
        output: objectOutput,
        execute: async (args: Record<string, unknown>) => {
          try {
            return await this.operations.toolCall(skill, spec.toolId, args ?? {})
          } catch (error) {
            if (error instanceof ForgeError) return { ok: false, code: error.code, message: error.message }
            return { ok: false, code: 'FORGE_INTERNAL', message: (error as Error).message }
          }
        },
      })
      disposers.push(this.ctx.tools.register(definition))
      registered.push(name)
    }
    this.disposers.set(skill, disposers)
    return { registered }
  }

  /** Remove the typed tools of one skill. */
  dispose(skill: string): void {
    const list = this.disposers.get(skill)
    if (list === undefined) return
    for (const dispose of list) dispose()
    this.disposers.delete(skill)
  }

  disposeAll(): void {
    for (const skill of [...this.disposers.keys()]) this.dispose(skill)
  }
}

/** Stable, platform-safe tool name: `forge_<skill>_<tool>`, bounded to 64 chars. */
export function toolNameFor(skill: string, toolId: string): string {
  const base = `forge_${sanitize(skill)}_${sanitize(toolId)}`
  if (base.length <= 64) return base
  let hash = 0
  for (const character of `${skill}:${toolId}`) hash = (hash * 31 + character.codePointAt(0)!) >>> 0
  return `${base.slice(0, 56)}_${hash.toString(16).slice(0, 6)}`
}

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function describeTool(spec: GatewayTool): string {
  const raw = (spec.raw ?? {}) as Record<string, unknown>
  const description = typeof raw['description'] === 'string' ? raw['description'] : ''
  return description.length > 0 ? description : `${spec.toolId} (${spec.semantics ?? 'tool'})`
}

/**
 * Convert a Gateway `input_schema` into the tool DSL's parameter spec.
 * Unsupported constructs degrade to `{ type: 'json' }` rather than failing the
 * registration; the gateway still validates the real schema.
 */
export function jsonSchemaToParameters(raw: unknown): Record<string, unknown> {
  const schema = (raw ?? {}) as Record<string, unknown>
  const properties = (schema['properties'] ?? {}) as Record<string, unknown>
  const required = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : [])
  const parameters: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(properties)) {
    const converted = convertNode(value)
    parameters[key] = required.has(key) ? { ...converted, required: true } : converted
  }
  return parameters
}

function convertNode(raw: unknown): Record<string, unknown> {
  const node = (raw ?? {}) as Record<string, unknown>
  const description = typeof node['description'] === 'string' ? node['description'] : undefined
  const withDescription = (spec: Record<string, unknown>): Record<string, unknown> =>
    description === undefined ? spec : { ...spec, description }

  if (Array.isArray(node['oneOf'])) {
    const branches = (node['oneOf'] as unknown[]).map(convertNode)
    if (branches.length >= 2) return withDescription({ oneOf: branches.slice(0, 4) })
    return withDescription({ type: 'json' })
  }

  const type = typeof node['type'] === 'string' ? node['type'] : inferType(node)
  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
      return withDescription({
        type,
        ...(Array.isArray(node['enum']) ? { enum: node['enum'] } : {}),
        ...(node['const'] === undefined ? {} : { const: node['const'] }),
      })
    case 'array': {
      const items = node['items'] === undefined ? { type: 'json' } : convertNode(node['items'])
      return withDescription({ type: 'array', items })
    }
    case 'object': {
      const nested = (node['properties'] ?? {}) as Record<string, unknown>
      const required = new Set(Array.isArray(node['required']) ? (node['required'] as string[]) : [])
      const properties: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(nested)) {
        const converted = convertNode(value)
        properties[key] = required.has(key) ? { ...converted, required: true } : converted
      }
      return withDescription({ type: 'object', properties, additionalProperties: node['additionalProperties'] === true })
    }
    default:
      return withDescription({ type: 'json' })
  }
}

function inferType(node: Record<string, unknown>): string | undefined {
  if (!Array.isArray(node['enum']) || node['enum'].length === 0) return undefined
  const first = node['enum'][0]
  if (typeof first === 'string') return 'string'
  if (typeof first === 'number') return Number.isInteger(first) ? 'integer' : 'number'
  if (typeof first === 'boolean') return 'boolean'
  return undefined
}
