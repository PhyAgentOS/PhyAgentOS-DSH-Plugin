import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { join, resolve } from 'node:path'
import {
  DEFAULT_REGISTRY_URL,
  DshProfileStore,
  ForgeOperations,
  ForgeRegistryClient,
  SkillFileStore,
  forgePaths,
  resolveForgeHome,
} from '@x-era/forge-core'

import { DynamicToolRegistry } from './dynamic.js'
import { DEVELOPMENT_SKILL_CONTENT, DEVELOPMENT_SKILL_DESCRIPTION, DEVELOPMENT_SKILL_NAME } from './development.js'
import {
  RUNTIME_RULES_SECTION,
  USAGE_SKILL_CONTENT,
  USAGE_SKILL_DESCRIPTION,
  USAGE_SKILL_NAME,
  USAGE_SYSTEM_SECTION,
} from './usage.js'
import { createForgeProvider } from './provider.js'
import { registerForgeTools } from './tools.js'
import { handleApi, readJsonBody } from './ui/api.js'
import { startUiServer } from './ui/server.js'
import { watchRoots } from './watch.js'

export const name = 'forge-skill'

export const inject = ['skills', 'tools']

export interface ForgeSkillConfig {
  readonly home?: string
  readonly skills?: {
    readonly roots?: readonly string[]
    readonly watch?: boolean
  }
  readonly registry?: {
    readonly url?: string
    readonly timeoutMs?: number
    readonly token?: string
    readonly tokenEnv?: string
  }
  readonly runtime?: {
    readonly dora?: string
    readonly dora1?: string
    readonly startTimeoutMs?: number
  }
  readonly gateway?: {
    readonly callTimeoutMs?: number
    readonly dynamic?: 'off' | 'whitelist' | 'all'
    readonly dynamicSkills?: readonly string[]
  }
  readonly logs?: {
    readonly events?: boolean
  }
  readonly prompt?: {
    readonly usageSkill?: boolean
    readonly developmentSkill?: boolean
    readonly section?: boolean
    readonly runtimeRules?: boolean
  }
  readonly ui?: {
    readonly port?: number
    readonly enabled?: boolean
    readonly standalone?: boolean
  }
}

export const Config = z.object({
  home: z.string().default(''),
  skills: z.object({
    roots: z.array(z.string()).default([]),
    watch: z.boolean().default(true),
  }),
  registry: z.object({
    url: z.string().default(''),
    timeoutMs: z.number().default(20000),
    token: z.string().default(''),
    tokenEnv: z.string().default(''),
  }),
  runtime: z.object({
    dora: z.string().default(''),
    dora1: z.string().default(''),
    startTimeoutMs: z.number().default(120000),
  }),
  gateway: z.object({
    callTimeoutMs: z.number().default(15000),
    dynamic: z.union(['off', 'whitelist', 'all']).default('off'),
    dynamicSkills: z.array(z.string()).default([]),
  }),
  logs: z.object({
    events: z.boolean().default(true),
  }),
  prompt: z.object({
    usageSkill: z.boolean().default(true),
    developmentSkill: z.boolean().default(true),
    section: z.boolean().default(true),
    runtimeRules: z.boolean().default(true),
  }),
  ui: z.object({
    port: z.number().default(19080),
    enabled: z.boolean().default(true),
    standalone: z.boolean().default(false),
  }),
})

/**
 * Mount the forge capability into a DSH profile.
 *
 * Skills stay data: the provider answers from disk on every read and the
 * watcher calls `invalidate()` so catalog changes reach consumers without a
 * restart. Everything else is the shared `ForgeOperations` layer, also used by
 * the CLI and the MCP server.
 */
export function apply(ctx: Context, config: ForgeSkillConfig = {}): void {
  const home = resolveForgeHome(config.home)
  const paths = forgePaths(home)
  const configured = config.skills?.roots ?? []
  const roots = configured.length === 0
    ? [paths.skills]
    : configured.map(root => resolve(paths.home, root))

  const registry = new ForgeRegistryClient({
    baseUrl: config.registry?.url === undefined || config.registry.url.length === 0
      ? (process.env['DSH_FORGE_REGISTRY_URL'] ?? DEFAULT_REGISTRY_URL)
      : config.registry.url,
    timeoutMs: config.registry?.timeoutMs,
    ...(config.registry?.token === undefined || config.registry.token.length === 0 ? {} : { token: config.registry.token }),
    ...(config.registry?.tokenEnv === undefined || config.registry.tokenEnv.length === 0 ? {} : { tokenEnv: config.registry.tokenEnv }),
  })

  let invalidate: () => void = () => undefined
  const operations = new ForgeOperations({
    home,
    roots,
    registry,
    dora: config.runtime?.dora === undefined || config.runtime.dora.length === 0 ? undefined : config.runtime.dora,
    dora1: config.runtime?.dora1 === undefined || config.runtime.dora1.length === 0 ? undefined : config.runtime.dora1,
    startTimeoutMs: config.runtime?.startTimeoutMs,
    callTimeoutMs: config.gateway?.callTimeoutMs,
    events: config.logs?.events !== false,
    onCatalogChange: () => invalidate(),
  })

  const dynamicMode = config.gateway?.dynamic ?? 'off'
  const dynamic = dynamicMode === 'off'
    ? undefined
    : new DynamicToolRegistry(ctx, operations, { mode: dynamicMode, skills: config.gateway?.dynamicSkills ?? [] })
  const disposeTools = registerForgeTools(ctx, { operations, roots, dynamic })
  if (dynamic !== undefined) {
    ctx.effect(() => () => dynamic.disposeAll())
    // Re-register typed tools for runtimes that were already healthy at mount.
    void (async () => {
      for (const skill of await operations.installedDirs()) {
        const name = skill.slice(skill.lastIndexOf('/') + 1)
        await dynamic.refresh(name).catch(() => undefined)
      }
    })()
  }
  ctx.effect(() => () => {
    for (const dispose of disposeTools) dispose()
  })

  if (config.prompt?.usageSkill !== false) {
    const disposeUsage = ctx.skills.register({
      name: USAGE_SKILL_NAME,
      description: USAGE_SKILL_DESCRIPTION,
      content: USAGE_SKILL_CONTENT,
      whenToUse: 'Use when the user asks about Forge skills, profiles, runtimes or gateway tools.',
      source: 'runtime',
    })
    ctx.effect(() => disposeUsage)
  }

  if (config.prompt?.developmentSkill !== false) {
    const disposeDevelopment = ctx.skills.register({
      name: DEVELOPMENT_SKILL_NAME,
      description: DEVELOPMENT_SKILL_DESCRIPTION,
      content: DEVELOPMENT_SKILL_CONTENT,
      whenToUse: 'Use when creating, modifying, packaging or debugging a forge skill bundle.',
      source: 'runtime',
    })
    ctx.effect(() => disposeDevelopment)
  }

  if (config.prompt?.runtimeRules !== false) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      const systemPrompt = promptCtx.systemPrompt
      if (systemPrompt === undefined) return
      promptCtx.effect(() => systemPrompt.section({
        name: 'forge-runtime-rules',
        order: 96,
        interpolate: false,
        text: RUNTIME_RULES_SECTION,
      }))
    })
  }

  if (config.prompt?.section !== false) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      const systemPrompt = promptCtx.systemPrompt
      if (systemPrompt === undefined) return
      promptCtx.effect(() => systemPrompt.section({
        name: 'forge-tools',
        order: 95,
        interpolate: false,
        text: USAGE_SYSTEM_SECTION,
      }))
    })
  }

  const disposeProvider = ctx.skills.registerProvider((control) => {
    invalidate = control.invalidate
    const watcher = config.skills?.watch === false
      ? undefined
      : watchRoots(roots, () => {
        ctx.logger.info('forge-skill: skill root changed, catalog invalidated')
        control.invalidate()
      })
    control.signal.addEventListener('abort', () => watcher?.close(), { once: true })
    ctx.logger.info(`forge-skill: catalog mounted over ${roots.join(', ')}`)
    return createForgeProvider({ catalogs: operations.catalogs })
  })
  ctx.effect(() => disposeProvider)

  ctx.effect(() => () => {
    void operations.runtime.stopAll()
  })

  if (config.ui?.enabled !== false) {
    const apiDeps = {
      profiles: new DshProfileStore(),
      files: new SkillFileStore(operations.catalog, join(paths.runtime, 'backups')),
      currentProfile: ctx.profileContext?.name,
    }

    ctx.inject(['webServer'], (webCtx) => {
      const webServer = webCtx.webServer
      if (webServer === undefined) return
      webCtx.effect(() => webServer.register({
        kind: 'prefix',
        path: '/forge/api',
        handler: async (request, response) => {
          const req = request as import('node:http').IncomingMessage
          const res = response as import('node:http').ServerResponse
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          if ((req.method === 'PUT' || req.method === 'POST') && !(req.headers['content-type'] ?? '').includes('application/json')) {
            res.writeHead(415, { 'content-type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'PUT requires application/json' }))
            return
          }
          const result = await handleApi(req.method ?? 'GET', url, apiDeps, () => readJsonBody(req))
          res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify(result.body))
        },
      }))
      ctx.logger.info('forge-skill: configuration API mounted at /forge/api')
    })

    if (config.ui?.standalone === true) {
      const port = config.ui?.port ?? 19080
      let server: { close(): void } | undefined
      void startUiServer({ ...apiDeps, port }).then((started) => {
        server = started
        ctx.logger.info(`forge-skill: standalone console at http://127.0.0.1:${port}/`)
      }).catch((error: unknown) => {
        ctx.logger.warn(`forge-skill: standalone console failed: ${(error as Error).message}`)
      })
      ctx.effect(() => () => server?.close())
    }
  }
}
