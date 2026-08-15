/**
 * The composer vision-model menu endpoints: list the offered free-vision
 * groups, read the current selection, and save a new one. Mounted on the web
 * server like the paste route; the client fetches these with no other
 * transport dependency.
 * @module @dsh-external/dsh-vision-plugin/vision-model-menu
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { VisionModelSelection } from './vision-model-selection.ts'
import { isOfferedRoute, resolveVisionModelGroups } from './vision-models.ts'

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = []
    let total = 0
    req.on('data', (chunk: Uint8Array) => {
      total += chunk.length
      if (total > maxBytes) {
        reject(new Error(`body over the ${maxBytes}-byte limit`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Register the vision-model menu endpoints.
 * @param ctx - the web-server scoped context.
 * @param host - the plugin context (llm service for topology).
 * @param selection - the shared selection state.
 */
export function registerVisionModelMenu(ctx: Context, host: Context, selection: VisionModelSelection): void {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return

  webServer.register({
    kind: 'exact',
    path: '/vision-plugin/vision-models',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        const groups = await resolveVisionModelGroups(host)
        const current = selection.currentRoute()
        json(res, 200, {
          groups,
          current: current === undefined ? null : current,
        })
      } catch (error: unknown) {
        json(res, 500, { error: String(error instanceof Error ? error.message : error) })
      }
    },
  })

  webServer.register({
    kind: 'exact',
    path: '/vision-plugin/vision-model',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') {
        const current = selection.currentRoute()
        json(res, 200, current === undefined ? null : current)
        return
      }
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      try {
        const body = await readBody(req, 4096)
        const parsed = JSON.parse(body.toString('utf8')) as { provider?: unknown; model?: unknown }
        if (typeof parsed.provider !== 'string' || typeof parsed.model !== 'string') {
          json(res, 400, { error: 'body must be { provider: string, model: string }' })
          return
        }
        const route = { provider: parsed.provider, model: parsed.model }
        const groups = await resolveVisionModelGroups(host)
        if (!isOfferedRoute(groups, route)) {
          json(res, 400, { error: `no free vision model ${route.provider}/${route.model} is offered` })
          return
        }
        selection.select(route)
        json(res, 200, route)
      } catch (error: unknown) {
        json(res, 500, { error: String(error instanceof Error ? error.message : error) })
      }
    },
  })
}
