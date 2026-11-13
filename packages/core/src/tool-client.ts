import { ForgeError } from './errors.js'

/** One ToolSpec as exposed by the Gateway. */
export interface GatewayTool {
  readonly toolId: string
  readonly semantics?: string
  readonly endpointId?: string
  readonly operation?: string
  readonly raw: unknown
}

/** Normalized result of a gateway call. */
export interface GatewayResult {
  readonly ok: boolean
  readonly httpStatus: number
  readonly invocationId?: string
  readonly phase?: string
  readonly data: unknown
}

/**
 * Anonymous HTTP client for the Forge Tool API.
 *
 * The gateway URL always comes from the skill manifest; this client never
 * guesses a port.
 */
export class ForgeToolClient {
  readonly gatewayUrl: string
  private readonly timeoutMs: number

  constructor(gatewayUrl: string, timeoutMs = 15000) {
    this.gatewayUrl = gatewayUrl.replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
  }

  /** Discover the tools the running gateway exposes. */
  async tools(): Promise<GatewayTool[]> {
    const value = (await this.request('GET', '/tools')).data as unknown
    const data = (value as { data?: unknown })?.data ?? value
    const list = Array.isArray(data) ? data : (data as { tools?: unknown })?.tools
    if (!Array.isArray(list)) return []
    return list.map(item => {
      const record = item as Record<string, unknown>
      const toolId = String(record['tool_id'] ?? record['id'] ?? record['name'] ?? '')
      return {
        toolId,
        semantics: typeof record['semantics'] === 'string' ? record['semantics'] : undefined,
        endpointId: typeof record['endpoint_id'] === 'string' ? record['endpoint_id'] : undefined,
        operation: typeof record['operation'] === 'string' ? record['operation'] : undefined,
        raw: item,
      }
    }).filter(tool => tool.toolId.length > 0)
  }

  /** Read the live context/readiness of one tool without invoking it. */
  async context(toolId: string): Promise<unknown> {
    return (await this.request('GET', `/tools/${encodeURIComponent(toolId)}/context`)).data
  }

  /** Invoke a tool; queries route through their endpoint operation, actions through the tool id. */
  async invoke(toolId: string, args: Record<string, unknown>, timeoutMs?: number): Promise<GatewayResult> {
    const spec = await this.spec(toolId)
    const path = spec?.semantics === 'query' && spec.endpointId !== undefined && spec.operation !== undefined
      ? `/tools/${encodeURIComponent(spec.endpointId)}/${encodeURIComponent(spec.operation)}:invoke`
      : `/tools/${encodeURIComponent(toolId)}:invoke`
    return this.request('POST', path, { arguments: args, timeout_ms: Math.min(timeoutMs ?? this.timeoutMs, 20000) })
  }

  private async spec(toolId: string): Promise<GatewayTool | undefined> {
    try {
      const tools = await this.tools()
      return tools.find(tool => tool.toolId === toolId)
    } catch {
      return undefined
    }
  }

  /** Read invocation status. */
  async invocation(invocationId: string): Promise<unknown> {
    return (await this.request('GET', `/invocations/${encodeURIComponent(invocationId)}`)).data
  }

  /** Read invocation result. */
  async result(invocationId: string): Promise<unknown> {
    return (await this.request('GET', `/invocations/${encodeURIComponent(invocationId)}/result`)).data
  }

  /** Request cancellation without asserting that anything stopped. */
  async cancel(invocationId: string): Promise<unknown> {
    return this.request('POST', `/invocations/${encodeURIComponent(invocationId)}/cancel`, {})
  }

  /** Stop an owned session. */
  async stopSession(invocationId: string): Promise<unknown> {
    return this.request('POST', `/invocations/${encodeURIComponent(invocationId)}/stop`, {})
  }

  private async request(method: string, path: string, body?: unknown): Promise<GatewayResult> {
    let response: Response
    try {
      response = await fetch(`${this.gatewayUrl}${path}`, {
        method,
        headers: body === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      throw new ForgeError('FORGE_GATEWAY_UNREACHABLE', `${path}: ${(error as Error).message}`)
    }
    const text = await response.text()
    let payload: unknown = text
    try {
      payload = text.length === 0 ? undefined : JSON.parse(text)
    } catch {
      // keep raw text
    }
    const record = (payload ?? {}) as Record<string, unknown>
    const data = record['data'] ?? payload
    const invocationId = typeof data === 'object' && data !== null
      ? ((data as Record<string, unknown>)['invocation_id'] as string | undefined)
      : undefined
    const phase = typeof data === 'object' && data !== null
      ? ((data as Record<string, unknown>)['phase'] as string | undefined)
      : undefined
    if (!response.ok) {
      const message = typeof record['message'] === 'string' ? record['message'] : text.slice(0, 300)
      throw new ForgeError('FORGE_GATEWAY_UNREACHABLE', `${method} ${path}: HTTP ${response.status} ${message}`)
    }
    return {
      ok: record['ok'] !== false,
      httpStatus: response.status,
      ...(invocationId === undefined ? {} : { invocationId }),
      ...(phase === undefined ? {} : { phase }),
      data: payload,
    }
  }
}
