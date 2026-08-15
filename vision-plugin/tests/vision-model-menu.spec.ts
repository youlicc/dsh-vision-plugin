/**
 * Vision-model menu endpoints: the offered-groups list (configured providers
 * only), the current-selection read, and the validated selection write. The
 * web server is faked (route capture); the llm topology is real.
 */

import { describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { registerVisionModelMenu } from '../src/vision-model-menu.ts'
import { VisionModelSelection } from '../src/vision-model-selection.ts'
import { defaultVisionRoute, resolveVisionModelGroups } from '../src/vision-models.ts'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

class CatalogAdapter extends LlmAdapter {
  constructor(private readonly models: readonly LlmModelInfo[]) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(): AsyncIterable<never> {
    // Endpoint tests never stream.
  }
}

function entry(provider: string, id: string, name = id): LlmModelInfo {
  return { provider, id, name, inputModalities: ['text', 'image'] }
}

interface Captured {
  route: WebRoute
  invoke(req: Partial<IncomingMessage> & { method: string; url?: string }, body?: string): Promise<{ status: number; json: unknown }>
}

/** Fake ServerResponse collecting the status and the JSON body. */
function fakeRes(): { res: ServerResponse; result: () => { status: number; json: unknown } } {
  let status = 200
  let json: unknown = undefined
  const res = {
    writeHead: (code: number) => { status = code },
    end: (payload?: unknown) => {
      if (typeof payload === 'string') {
        try { json = JSON.parse(payload) } catch { json = payload }
      }
    },
  } as unknown as ServerResponse
  return { res, result: () => ({ status, json }) }
}

/** A fake IncomingMessage that emits `body` through the stream like node http. */
function fakeReq(partial: Partial<IncomingMessage> & { method: string; url?: string }, body?: string): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage
  Object.assign(req, partial)
  req.destroy = (() => {}) as unknown as IncomingMessage['destroy']
  if (body !== undefined) {
    queueMicrotask(() => {
      req.emit('data', Buffer.from(body))
      req.emit('end')
    })
  }
  return req
}

async function menuHarness(models: Record<string, readonly LlmModelInfo[]>) {
  const host = new Context()
  void new LlmRuntime(host)
  for (const [provider, list] of Object.entries(models)) {
    host.llm.registerAdapter([provider], new CatalogAdapter(list))
  }
  const selection = new VisionModelSelection()
  const routes: Captured[] = []
  const webServer = {
    register: (route: WebRoute): (() => void) => {
      const at = routes.length
      routes.push({
        route,
        invoke: async (req, body) => {
          const { res, result } = fakeRes()
          await route.handler(fakeReq(req, body), res)
          return result()
        },
      })
      return () => { routes.splice(at, 1) }
    },
  }
  host.provide('webServer', webServer as never)
  registerVisionModelMenu(host, host, selection)
  // Mirror index.ts: the default is refreshed from the resolved groups.
  selection.updateDefault(defaultVisionRoute(await resolveVisionModelGroups(host)))
  return { host, selection, routes }
}

function routeOf(routes: Captured[], path: string): Captured {
  const found = routes.find(captured => captured.route.path === path)
  if (found === undefined) throw new Error(`no captured route ${path}`)
  return found
}

describe('vision-model menu endpoints', () => {
  it('GET /vision-plugin/vision-models lists only configured providers with their free models', async () => {
    const { host, routes } = await menuHarness({
      openrouter: [
        entry('openrouter', 'google/gemma-4-31b-it:free', 'Gemma 4 31B'),
        entry('openrouter', 'other/free-model'),
      ],
      opencode: [entry('opencode', 'mimo-v2.5-free', 'Mimo 2.5')],
    })
    const { status, json } = await routeOf(routes, '/vision-plugin/vision-models').invoke({ method: 'GET' })
    expect(status).toBe(200)
    const body = json as { groups: { provider: string; displayName: string; models: { id: string; name: string }[] }[]; current: unknown }
    expect(body.groups.map(group => group.provider)).toEqual(['openrouter', 'opencode'])
    expect(body.groups[0]!.models).toEqual([{ id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B' }])
    // Default selection: first offered model in catalog order.
    expect(body.current).toEqual({ provider: 'openrouter', model: 'google/gemma-4-31b-it:free' })
    await host.fiber.dispose()
  })

  it('returns an empty list when no configured provider offers a free model', async () => {
    const { host, routes } = await menuHarness({ deepseek: [entry('deepseek', 'deepseek-chat')] })
    const { status, json } = await routeOf(routes, '/vision-plugin/vision-models').invoke({ method: 'GET' })
    expect(status).toBe(200)
    expect(json).toEqual({ groups: [], current: null })
    await host.fiber.dispose()
  })

  it('GET /vision-plugin/vision-model returns the current selection', async () => {
    const { host, selection, routes } = await menuHarness({
      opencode: [entry('opencode', 'mimo-v2.5-free')],
    })
    const read = routeOf(routes, '/vision-plugin/vision-model')
    // The default (first offered model) is live before any explicit pick.
    const before = await read.invoke({ method: 'GET' })
    expect(before.json).toEqual({ provider: 'opencode', model: 'mimo-v2.5-free' })
    selection.select({ provider: 'opencode', model: 'mimo-v2.5-free' })
    const after = await read.invoke({ method: 'GET' })
    expect(after.json).toEqual({ provider: 'opencode', model: 'mimo-v2.5-free' })
    await host.fiber.dispose()
  })

  it('POST /vision-plugin/vision-model accepts an offered route and persists it', async () => {
    const { host, selection, routes } = await menuHarness({
      openrouter: [entry('openrouter', 'google/gemma-4-31b-it:free')],
      opencode: [entry('opencode', 'mimo-v2.5-free')],
    })
    const write = routeOf(routes, '/vision-plugin/vision-model')
    const { status, json } = await write.invoke(
      { method: 'POST' },
      JSON.stringify({ provider: 'opencode', model: 'mimo-v2.5-free' }),
    )
    expect(status).toBe(200)
    expect(json).toEqual({ provider: 'opencode', model: 'mimo-v2.5-free' })
    expect(selection.currentRoute()).toEqual({ provider: 'opencode', model: 'mimo-v2.5-free' })
    await host.fiber.dispose()
  })

  it('POST rejects a route outside the offered groups', async () => {
    const { host, selection, routes } = await menuHarness({
      openrouter: [entry('openrouter', 'google/gemma-4-31b-it:free')],
    })
    const write = routeOf(routes, '/vision-plugin/vision-model')
    const { status, json } = await write.invoke(
      { method: 'POST' },
      JSON.stringify({ provider: 'openrouter', model: 'paid-model' }),
    )
    expect(status).toBe(400)
    expect((json as { error: string }).error).toMatch(/no free vision model/)
    // The explicit selection was rejected; the default stays untouched.
    expect(selection.currentRoute()).toEqual({ provider: 'openrouter', model: 'google/gemma-4-31b-it:free' })
    await host.fiber.dispose()
  })

  it('POST rejects malformed bodies', async () => {
    const { host, routes } = await menuHarness({ openrouter: [entry('openrouter', 'google/gemma-4-31b-it:free')] })
    const write = routeOf(routes, '/vision-plugin/vision-model')
    const malformed = await write.invoke({ method: 'POST' }, JSON.stringify({ provider: 7 }))
    expect(malformed.status).toBe(400)
    const oversized = await write.invoke({ method: 'POST' }, 'x'.repeat(5000))
    expect(oversized.status).toBe(500)
    await host.fiber.dispose()
  })

  it('rejects non-GET/POST methods with 405', async () => {
    const { host, routes } = await menuHarness({ openrouter: [entry('openrouter', 'google/gemma-4-31b-it:free')] })
    const list = await routeOf(routes, '/vision-plugin/vision-models').invoke({ method: 'PUT' })
    expect(list.status).toBe(405)
    const write = await routeOf(routes, '/vision-plugin/vision-model').invoke({ method: 'DELETE' })
    expect(write.status).toBe(405)
    await host.fiber.dispose()
  })
})
