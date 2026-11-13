import { createServer, type Server } from 'node:http'

import { handleApi, readJsonBody, type ApiDeps } from './api.js'
import { PAGE_HTML } from './page.js'

export interface UiServerOptions extends ApiDeps {
  readonly port: number
  readonly host?: string | undefined
}

/**
 * Standalone loopback console kept for debugging (`ui.standalone`).
 *
 * The product path serves the same API from the DSH web server; both call
 * `handleApi`, so validation cannot diverge.
 */
export async function startUiServer(options: UiServerOptions): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/' && request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(PAGE_HTML)
        return
      }
      if ((request.method === 'PUT' || request.method === 'POST') && !(request.headers['content-type'] ?? '').includes('application/json')) {
        response.writeHead(415, { 'content-type': 'application/json; charset=utf-8' })
        response.end(JSON.stringify({ ok: false, error: 'PUT requires application/json' }))
        return
      }
      const result = await handleApi(request.method ?? 'GET', url, options, () => readJsonBody(request))
      response.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(result.body))
    })().catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }))
    })
  })
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host ?? '127.0.0.1', () => resolveListen())
  })
  return server
}
