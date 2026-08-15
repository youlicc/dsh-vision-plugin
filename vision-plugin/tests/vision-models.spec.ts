/**
 * Vision-model catalog: the plugin-maintained FREE_VISION_MODELS list,
 * provider-group resolution against the live llm topology (registered routes
 * only), the default route (first offered in catalog order), and offered-route
 * validation.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import {
  FREE_VISION_MODELS, defaultVisionRoute, isOfferedRoute, resolveVisionModelGroups,
} from '../src/vision-models.ts'

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
    // Group-resolution tests never stream.
  }
}

/** One free model of the catalog, typed as a real catalog entry. */
function entry(provider: string, id: string, name = id): LlmModelInfo {
  return { provider, id, name, inputModalities: ['text', 'image'] }
}

function harness(routes: Record<string, readonly LlmModelInfo[]>) {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  for (const [provider, models] of Object.entries(routes)) {
    ctx.llm.registerAdapter([provider], new CatalogAdapter(models))
  }
  return ctx
}

describe('resolveVisionModelGroups', () => {
  it('offers only registered providers, intersected with the catalog', async () => {
    const ctx = harness({
      openrouter: [
        entry('openrouter', 'google/gemma-4-31b-it:free', 'Gemma 4 31B'),
        entry('openrouter', 'google/gemma-4-26b-a4b-it:free'),
        entry('openrouter', 'other/free-model'),
      ],
      opencode: [entry('opencode', 'mimo-v2.5-free', 'Mimo 2.5')],
    })
    const groups = await resolveVisionModelGroups(ctx)
    expect(groups.map(group => group.provider)).toEqual(['openrouter', 'opencode'])
    const openrouter = groups[0]!
    expect(openrouter.models.map(model => model.id)).toEqual([
      'google/gemma-4-31b-it:free',
      'google/gemma-4-26b-a4b-it:free',
    ])
    expect(openrouter.models[0]!.name).toBe('Gemma 4 31B')
    expect(groups[1]!.models.map(model => model.id)).toEqual(['mimo-v2.5-free'])
    await ctx.fiber.dispose()
  })

  it('skips providers whose catalog lacks any free vision model', async () => {
    const ctx = harness({
      openrouter: [entry('openrouter', 'not-free-model')],
      opencode: [entry('opencode', 'mimo-v2.5-free')],
    })
    const groups = await resolveVisionModelGroups(ctx)
    expect(groups.map(group => group.provider)).toEqual(['opencode'])
    await ctx.fiber.dispose()
  })

  it('returns [] when no catalog provider is registered', async () => {
    const ctx = harness({ deepseek: [entry('deepseek', 'deepseek-chat')] })
    const groups = await resolveVisionModelGroups(ctx)
    expect(groups).toEqual([])
    await ctx.fiber.dispose()
  })

  it('returns [] when the llm service is absent', async () => {
    const ctx = new Context()
    expect(await resolveVisionModelGroups(ctx)).toEqual([])
    await ctx.fiber.dispose()
  })

  it('skips a provider whose catalog lookup throws', async () => {
    const ctx = harness({ opencode: [entry('opencode', 'mimo-v2.5-free')] })
    const broken = new CatalogAdapter([entry('openrouter', 'google/gemma-4-31b-it:free')])
    vi.spyOn(broken, 'listModels').mockRejectedValueOnce(new Error('catalog down'))
    ctx.llm.registerAdapter(['openrouter'], broken)
    const groups = await resolveVisionModelGroups(ctx)
    expect(groups.map(group => group.provider)).toEqual(['opencode'])
    await ctx.fiber.dispose()
  })
})

describe('defaultVisionRoute', () => {
  it('picks the first offered model of the first offered group, in catalog order', () => {
    const groups = [
      { provider: 'opencode', displayName: 'Opencode', models: [{ id: 'mimo-v2.5-free', name: 'Mimo' }] },
      { provider: 'openrouter', displayName: 'OpenRouter', models: [{ id: 'google/gemma-4-31b-it:free', name: 'Gemma' }] },
    ]
    expect(defaultVisionRoute(groups)).toEqual({ provider: 'opencode', model: 'mimo-v2.5-free' })
  })

  it('returns undefined when nothing is offered', () => {
    expect(defaultVisionRoute([])).toBeUndefined()
    expect(defaultVisionRoute([{ provider: 'x', displayName: 'X', models: [] }])).toBeUndefined()
  })
})

describe('isOfferedRoute', () => {
  const groups = [
    { provider: 'openrouter', displayName: 'OpenRouter', models: [{ id: 'google/gemma-4-31b-it:free', name: 'Gemma' }] },
  ]

  it('accepts an offered route and rejects anything else', () => {
    expect(isOfferedRoute(groups, { provider: 'openrouter', model: 'google/gemma-4-31b-it:free' })).toBe(true)
    expect(isOfferedRoute(groups, { provider: 'openrouter', model: 'not-free' })).toBe(false)
    expect(isOfferedRoute(groups, { provider: 'opencode', model: 'mimo-v2.5-free' })).toBe(false)
  })
})

describe('FREE_VISION_MODELS catalog', () => {
  it('is the authoritative free-vision list, grouped by provider', () => {
    expect(Object.keys(FREE_VISION_MODELS).sort()).toEqual(['opencode', 'openrouter'])
    expect(FREE_VISION_MODELS.openrouter!.length).toBeGreaterThan(0)
    expect(FREE_VISION_MODELS.opencode).toEqual(['mimo-v2.5-free'])
  })
})
