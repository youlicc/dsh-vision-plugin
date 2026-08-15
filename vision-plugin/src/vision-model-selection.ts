/**
 * The process-local vision-model selection. Defaults to the first offered
 * free model in catalog order (refreshed when the llm topology changes); the
 * describe service reads the live selection so the composer menu switch
 * takes effect on the next recognition.
 * @module @dsh-external/dsh-vision-plugin/vision-model-selection
 */

import type { VisionRoute } from './vision-models.ts'

/** Owns the mutable current vision route and its change notifications. */
export class VisionModelSelection {
  private current: VisionRoute | undefined
  private fallback: VisionRoute | undefined

  /** Listener invoked with the new route after each change (or undefined on reset). */
  private readonly listeners = new Set<(route: VisionRoute | undefined) => void>()

  /** The current route, or the default when none was picked yet. */
  currentRoute(): VisionRoute | undefined {
    return this.current ?? this.fallback
  }

  /**
   * Refresh the default (first offered free model in catalog order).
   * @param route - the newly resolved default, or undefined when nothing is offered.
   */
  updateDefault(route: VisionRoute | undefined): void {
    if (this.fallback?.provider === route?.provider && this.fallback?.model === route?.model) return
    this.fallback = route
    if (this.current === undefined) {
      for (const listener of this.listeners) listener(this.currentRoute())
    }
  }

  /**
   * Set the selected route (caller validates it against the offered groups).
   * @param route - the route to select.
   */
  select(route: VisionRoute): void {
    if (this.current?.provider === route.provider && this.current.model === route.model) return
    this.current = route
    for (const listener of this.listeners) listener(route)
  }

  /** Drop the explicit selection, returning to the default. */
  reset(): void {
    if (this.current === undefined) return
    this.current = undefined
    for (const listener of this.listeners) listener(this.currentRoute())
  }

  /** Subscribe to selection changes; returns a disposer. */
  onChange(listener: (route: VisionRoute | undefined) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
