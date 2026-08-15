/**
 * The plugin-maintained free-vision-model catalog, grouped by provider route.
 * This is the authoritative "free vision" list (per requirement: judged by
 * this list, never by scanning model metadata for cost fields — dsh exposes
 * none). A provider route is offered only when it is registered in the
 * running llm topology, and each listed model is cross-checked against that
 * provider's own catalog.
 * @module @dsh-external/dsh-vision-plugin/vision-models
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Free vision models by provider route, in display order. Extend this table
 * when a new free vision model appears on a route.
 */
export const FREE_VISION_MODELS: Readonly<Record<string, readonly string[]>> = {
  openrouter: [
    'google/gemma-4-31b-it:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-nano-12b-v2-vl:free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
  ],
  opencode: ['mimo-v2.5-free'],
}

/** One model entry for the menu. */
export interface VisionModelEntry {
  /** The model id on the provider route. */
  id: string
  /** Display name (falls back to the id). */
  name: string
}

/** One provider group for the menu. */
export interface VisionModelGroup {
  /** The provider route id. */
  provider: string
  /** Provider display name. */
  displayName: string
  /** Free vision models of this provider that are registered and resolvable. */
  models: readonly VisionModelEntry[]
}

/** The provider/model pair backing one selection. */
export interface VisionRoute {
  provider: string
  model: string
}

/**
 * Resolve the provider groups offered by this deployment: routes registered
 * in the llm topology, intersected with {@link FREE_VISION_MODELS}, with each
 * listed model cross-checked against the provider's own catalog.
 * @param ctx - the plugin context carrying the llm service.
 * @returns the offered groups in catalog order.
 */
export async function resolveVisionModelGroups(ctx: Context): Promise<VisionModelGroup[]> {
  const llm = ctx.get('llm')
  if (llm === undefined) return []
  const providers = new Map(llm.listProviders().map(provider => [provider.id, provider.name]))
  const groups: VisionModelGroup[] = []
  for (const [provider, modelIds] of Object.entries(FREE_VISION_MODELS)) {
    const displayName = providers.get(provider)
    if (displayName === undefined) continue // provider not configured
    let catalog: ReadonlyArray<{ id: string; name?: string }>
    try {
      catalog = await llm.listModels(provider)
    } catch {
      continue // catalog failure: skip the group
    }
    const catalogIds = new Set(catalog.map(model => model.id))
    const models = modelIds
      .filter(id => catalogIds.has(id))
      .map(id => {
        const entry = catalog.find(model => model.id === id)
        return { id, name: entry?.name ?? id }
      })
    if (models.length === 0) continue
    groups.push({ provider, displayName, models })
  }
  return groups
}

/**
 * The default selection: the first offered model of the first offered group,
 * in catalog order.
 * @param groups - the resolved provider groups.
 * @returns the default route, or `undefined` when nothing is offered.
 */
export function defaultVisionRoute(groups: readonly VisionModelGroup[]): VisionRoute | undefined {
  const first = groups[0]
  const model = first?.models[0]
  if (first === undefined || model === undefined) return undefined
  return { provider: first.provider, model: model.id }
}

/**
 * Validate a selection candidate against the offered groups.
 * @param groups - the resolved provider groups.
 * @param route - the candidate provider/model pair.
 * @returns whether the route is offered.
 */
export function isOfferedRoute(
  groups: readonly VisionModelGroup[],
  route: VisionRoute,
): boolean {
  const group = groups.find(candidate => candidate.provider === route.provider)
  return group?.models.some(model => model.id === route.model) ?? false
}
