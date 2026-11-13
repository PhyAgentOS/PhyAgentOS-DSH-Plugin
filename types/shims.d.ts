/**
 * M0 类型桩：只声明本仓库用到的最小表面。
 *
 * 运行时这些模块由 DSH 宿主提供（immutable runtime resolution），
 * 构建时用这里的声明做类型检查。M1 起改为依赖真实包版本。
 */

declare module '@deepseek-ai/cordis' {
  export interface Logger {
    info(...args: unknown[]): void
    warn(...args: unknown[]): void
    error(...args: unknown[]): void
  }

  export interface Disposable {
    (): void
  }

  export interface Context {
    readonly logger: Logger
    readonly skills: {
      registerProvider(create: (control: import('@deepseek-ai/dsh-skill').SkillProviderControl) => import('@deepseek-ai/dsh-skill').SkillProvider): Disposable
      register(skill: {
        name: string
        description: string
        content: string
        source?: string
        whenToUse?: string
        metadata?: Readonly<Record<string, unknown>>
        invocation?: { modelInvocable: boolean; userInvocable: boolean }
        provider?: string
      }): Disposable
    }
    readonly tools: {
      register(definition: import('@deepseek-ai/dsh-tools').ToolDefinition): Disposable
    }
    effect(fn: () => (() => void) | void): Disposable
    /** Present only in a profile launched by dsh. */
    readonly profileContext?: { readonly name?: string; readonly dir?: string }
    /** The DSH web server; absent in headless-style hosts. */
    inject(keys: readonly string[], callback: (ctx: Context) => void): void
    readonly systemPrompt?: {
      section(options: { name: string; order?: number; interpolate?: boolean; text: string }): () => void
    }
    readonly webServer?: {
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: unknown, res: unknown) => void | Promise<void>
      }): () => void
    }
  }

  export class Service {
    constructor(ctx: Context, name: string)
  }
}

declare module '@deepseek-ai/schemastery' {
  export interface Schema<T> {
    readonly _value?: T
    default(value: unknown): Schema<T>
  }

  export interface Schemastery {
    string(): Schema<string>
    number(): Schema<number>
    boolean(): Schema<boolean>
    array<T>(item: Schema<T>): Schema<T[]>
    union(values: readonly string[]): Schema<string>
    object<T>(shape: Record<string, Schema<unknown>>): Schema<T>
  }

  const z: Schemastery
  export default z
}

declare module '@deepseek-ai/dsh-tools' {
  export interface ToolContent {
    type: 'text'
    text: string
  }

  export interface ToolOutput<T> {
    schema: Record<string, unknown>
    render(args: unknown, value: T): ToolContent[]
  }

  export interface ToolDefinition {
    name: string
    description: string
    parameters: unknown
    output: ToolOutput<unknown>
    execute(args: any, exec: any): Promise<unknown>
  }

  export interface DefineToolOptions<T> {
    name: string
    description: string
    parameters?: unknown
    output: ToolOutput<T>
    execute(args: any, exec: any): Promise<T>
  }

  export function defineTool<T>(options: DefineToolOptions<T>): ToolDefinition
}

declare module '@deepseek-ai/dsh-skill' {
  export interface SkillInvocationPolicy {
    readonly modelInvocable: boolean
    readonly userInvocable: boolean
  }

  export interface SkillResourceBase {
    readonly kind: 'directory' | 'url' | 'opaque'
    readonly path?: string
    readonly url?: string
    readonly description?: string
  }

  export interface SkillSummary {
    readonly path?: string
    readonly name: string
    readonly description: string
    readonly whenToUse?: string
    readonly invocation: SkillInvocationPolicy
    readonly source: string
    readonly provider: string
    readonly resourceBase?: SkillResourceBase
  }

  export interface SkillCandidate extends SkillSummary {
    readonly rank: number
    readonly locator: unknown
    readonly metadata?: Readonly<Record<string, unknown>>
  }

  export interface SkillDefinition extends SkillSummary {
    readonly content: string
    readonly metadata?: Readonly<Record<string, unknown>>
  }

  export interface SkillLookupOptions {
    readonly cwd?: string | undefined
    readonly signal?: AbortSignal | undefined
  }

  export interface SkillProviderControl {
    readonly signal: AbortSignal
    readonly invalidate: () => void
  }

  export interface SkillProvider {
    readonly name: string
    list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]>
    get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>
  }
}
