/**
 * dsh-vision-plugin: the vision bridge for text-only routes. Registers the
 * `describe_image` tool (any local image path, including the paste-to-path
 * temp files) backed by a configurable vision model chain, and the
 * paste-to-path intake: the browser half intercepts image pastes, uploads the
 * bytes here, and inserts the returned file path into the composer as text,
 * so a text-only model never trips image admission.
 * @module @dsh-external/dsh-vision-plugin
 */

import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { Config, type Config as ConfigShape } from './config.ts'
import { DescribeService } from './describe.ts'
import { applyDescribeImageTool } from './describe-image.ts'
import { registerPasteRoute } from './paste.ts'
import { applyWrappedProviders } from './wrapped-provider.ts'

export const name = 'dsh-vision-plugin'

/** Services the plugin body reads through the context property proxy. */
export const inject = ['tools', 'systemPrompt']

export { Config }

export function apply(ctx: Context, config: ConfigShape): void {
  const describe = new DescribeService(ctx, config)

  // The tool registers unconditionally; execution re-checks the mounted
  // services defensively, so a store-less deployment fails with a clear tool
  // error instead of a hidden registration gap.
  applyDescribeImageTool(ctx, describe)

  // Mirror `(vision)` models for text-only routes: selecting one keeps the
  // native thumbnail paste (image admission passes) while the wrapper
  // rewrites image blocks into descriptions before the real route.
  const disposeWrapped = applyWrappedProviders(ctx, describe, config.wrappedModels)
  ctx.effect(() => disposeWrapped, 'dsh-vision-plugin: wrapped vision providers')

  // Paste-to-path is web-only: the route mounts when the web server appears
  // and never where it does not (headless stays untouched).
  if (config.pasteToPath) {
    ctx.inject(['webServer'], (scope) => {
      registerPasteRoute(scope as Context, ctx, config)
    })
  }
}
