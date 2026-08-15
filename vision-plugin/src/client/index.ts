/**
 * Browser half of the dsh-vision-plugin: paste-to-path interception plus the
 * composer vision-model menu. The node half (src/index.ts) is the host logic;
 * this file is the browser plugin body registered through the same
 * `dsh.client` machinery as every other UI plugin package.
 * @module @dsh-external/dsh-vision-plugin/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the ui-conversation SlotMap merge (`conversation.input.right`).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { installPasteInterception } from './paste.ts'
import { VisionModelMenu } from './VisionModelMenu.tsx'

/** Required services: the slot registry owning the composer input seats. */
export const inject = ['slots']

/**
 * Client plugin body: register the menu into `conversation.input.right` once
 * the composer declares it (re-registering if that declaration reloads), and
 * install the paste interception. Both contributions are fiber-owned effects
 * — cordis collects them and disposes on unload.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register({
      name: 'conversation.input.right',
      id: 'vision-model-menu',
      order: 10,
    }, VisionModelMenu))

  ctx.effect(() => installPasteInterception(), 'dsh-vision-plugin: paste-to-path')
}
