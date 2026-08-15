/**
 * dsh-vision-plugin: the vision bridge for text-only routes. Registers the
 * `describe_image` / `describe_attachment` tools backed by a configurable
 * vision model chain, the paste-to-path intake, wrapped `(vision)` mirror
 * models, and the composer vision-model menu (auto-detected free vision
 * models per configured provider).
 * @module @dsh-external/dsh-vision-plugin
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, type Config as ConfigShape } from './config.ts'
import { DescribeService } from './describe.ts'
import { applyDescribeImageTool } from './describe-image.ts'
import { applyDescribeAttachmentTool } from './describe-attachment.ts'
import { registerPasteRoute } from './paste.ts'
import { applyWrappedProviders } from './wrapped-provider.ts'
import { registerVisionModelMenu } from './vision-model-menu.ts'
import { VisionModelSelection } from './vision-model-selection.ts'
import { defaultVisionRoute, resolveVisionModelGroups } from './vision-models.ts'

export const name = 'dsh-vision-plugin'

/** Services the plugin body reads through the context property proxy. */
export const inject = ['tools', 'systemPrompt']

export { Config }

export function apply(ctx: Context, config: ConfigShape): void {
  // The vision route chain: explicit config, else the composer menu
  // selection (auto-detected free vision models).
  const selection = new VisionModelSelection()
  const describe = new DescribeService(ctx, config, config.visionMenu ? selection : undefined)

  // The menu default is the first offered free vision model in catalog
  // order; it resolves only once the llm topology is mounted (pi-ai routes
  // land after settings load), so refresh it on the same events the wrapped
  // providers listen to.
  const refreshDefault = (): void => {
    void resolveVisionModelGroups(ctx).then(groups => {
      selection.updateDefault(defaultVisionRoute(groups))
    }).catch(() => { /* topology transient: keep the previous default */ })
  }
  const initial = setTimeout(refreshDefault, 0)
  // `llm/adapters-updated` is a documented-but-untyped notification; the
  // narrow ctx.on overloads do not know it, so call through a string-loose
  // face (same pattern as the wrapped providers).
  const onUpdated: () => void = (ctx.on as unknown as (name: string, listener: () => void) => () => void)(
    'llm/adapters-updated',
    refreshDefault,
  )
  ctx.effect(() => () => {
    clearTimeout(initial)
    onUpdated()
  }, 'dsh-vision-plugin: vision menu topology refresh')

  // Tools register unconditionally; execution re-checks the mounted services
  // defensively.
  applyDescribeImageTool(ctx, describe)
  applyDescribeAttachmentTool(ctx, describe)

  // Mirror `(vision)` models for text-only routes.
  const disposeWrapped = applyWrappedProviders(ctx, describe, config.wrappedModels)
  ctx.effect(() => disposeWrapped, 'dsh-vision-plugin: wrapped vision providers')

  // Paste-to-path and the vision-model menu are web-only: they mount when
  // the web server appears and never where it does not (headless stays a
  // tool-only bridge).
  if (config.pasteToPath || config.visionMenu) {
    ctx.inject(['webServer'], (scope) => {
      if (config.pasteToPath) registerPasteRoute(scope as Context, ctx, config)
      if (config.visionMenu) registerVisionModelMenu(scope as Context, ctx, selection)
    })
  }
}
