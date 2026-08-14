import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../deepseek-harness/vitest.shared.ts'

const HARNESS = resolve(__dirname, '../../deepseek-harness')

/**
 * The tsconfig extends deepseek-harness/tsconfig.base.json, whose paths map
 * every @deepseek-ai/* import to the harness source tree (with the vendored
 * framework packages pointing at their built lib/types declarations for the
 * compiler). The runtime needs the vendored sources instead — their .d.ts
 * cannot be loaded by Vite — so alias each vendored package to its src entry.
 */
const VENDOR_ALIASES = [
  ['@deepseek-ai/cordis', 'cordis'],
  ['@deepseek-ai/cosmokit', 'cosmokit'],
  ['@deepseek-ai/schemastery', 'schemastery'],
  ['@deepseek-ai/cordis-plugin-loader', 'loader'],
  ['@deepseek-ai/cordis-plugin-include', 'include'],
  ['@deepseek-ai/cordis-plugin-group', 'group'],
  ['@deepseek-ai/cordis-plugin-timer', 'timer'],
  ['@deepseek-ai/cordis-plugin-hmr', 'hmr'],
  ['@deepseek-ai/cordis-plugin-logger-console', 'logger-console'],
].map(([find, dir]) => ({
  find: find as string,
  replacement: `${HARNESS}/vendor/${dir}/src/index.ts`,
}))

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: VENDOR_ALIASES,
  },
  // Harness sources use standard TypeScript decorators that need the shared
  // transform plugin.
  plugins: [standardDecoratorPlugin()],
  test: { include: ['tests/**/*.spec.ts'] },
})
