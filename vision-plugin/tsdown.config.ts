import { clientBundle } from '../../deepseek-harness/packages/client/tsdown.client.ts'

/**
 * Dual-face build: the host half (lib/index.js, node) plus the browser
 * client bundle (lib/client.js, lazy-CJS module-table handoff). Reuses the
 * harness clientBundle preset so the client face gets the exact externals /
 * CSS-modules / purity treatment as dsh's own UI plugins. The lib entry is
 * the source tree (no tsc emit step), matching how this package built before.
 */
export default clientBundle('@dsh-external/dsh-vision-plugin', ['src/index.ts'], {
  lib: { external: [/^@deepseek-ai\//] },
})
