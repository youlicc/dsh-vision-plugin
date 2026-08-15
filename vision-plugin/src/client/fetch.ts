/**
 * Small fetch helpers for the vision-model menu endpoints.
 * @module @dsh-external/dsh-vision-plugin/client/fetch
 */

/** Fetch JSON from a plugin endpoint, throwing a readable error on failure. */
export async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init)
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string }
    const error = new Error(body.error ?? `request failed (${res.status})`) as Error & { status?: number }
    error.status = res.status
    throw error
  }
  return res.json() as Promise<T>
}

/** The plugin-maintained offered groups and the current selection. */
export interface VisionGroupsPayload {
  groups: readonly VisionModelGroup[]
  current: VisionRoute | null
}

/** One provider group in the menu. */
export interface VisionModelGroup {
  provider: string
  displayName: string
  models: readonly VisionModelEntry[]
}

/** One model row in the menu. */
export interface VisionModelEntry {
  id: string
  name: string
}

/** The provider/model pair backing one selection. */
export interface VisionRoute {
  provider: string
  model: string
}

/** Fetch the offered groups plus the live current selection. */
export function loadVisionGroups(): Promise<VisionGroupsPayload> {
  return fetchJson<VisionGroupsPayload>('/vision-plugin/vision-models', { headers: { accept: 'application/json' } })
}

/** Persist a selection on the host; resolves to the accepted route. */
export function saveVisionRoute(route: VisionRoute): Promise<VisionRoute> {
  return fetchJson<VisionRoute>('/vision-plugin/vision-model', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(route),
  })
}

/** The button copy for one route: the catalog display name when known, else the model id. */
export function routeLabel(groups: readonly VisionModelGroup[], current: VisionRoute | null): string {
  if (current === null) return ''
  for (const group of groups) {
    if (group.provider !== current.provider) continue
    for (const model of group.models) {
      if (model.id === current.model) return model.name || current.model
    }
  }
  return current.model
}
