import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import { standardDecoratorPlugin } from '../../deepseek-harness/vitest.shared.ts'

const HARNESS = resolve(__dirname, '../../deepseek-harness')

/**
 * The tsconfig extends deepseek-harness/tsconfig.base.client.json, whose
 * paths map every @deepseek-ai/* import to the harness source tree (with the
 * vendored framework packages pointing at their built lib/types declarations
 * for the compiler). The runtime needs the vendored sources instead — their
 * .d.ts cannot be loaded by Vite — so alias each vendored package to its src
 * entry.
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

/**
 * Browser-side test dependencies resolve from the harness install (this
 * plugin has no node_modules of its own). react/react-dom live in the pnpm
 * deduped store; @testing-library/react only in its own pnpm dir — each is
 * pinned to its actual location.
 */
const REACT = `${HARNESS}/node_modules/.pnpm/node_modules/react`
const REACT_DOM = `${HARNESS}/node_modules/.pnpm/node_modules/react-dom`
const BROWSER_ALIASES = [
  // react subpath imports map to the exact file so the exports map's
  // jsx-runtime / jsx-dev-runtime entries resolve; a bare package-root
  // replacement would lose the subpath.
  { find: 'react/jsx-dev-runtime', replacement: `${REACT}/jsx-dev-runtime.js` },
  { find: 'react/jsx-runtime', replacement: `${REACT}/jsx-runtime.js` },
  { find: 'react', replacement: `${REACT}/index.js` },
  { find: 'react-dom/client', replacement: `${REACT_DOM}/client.js` },
  { find: 'react-dom', replacement: `${REACT_DOM}/index.js` },
  {
    find: '@testing-library/react',
    replacement: `${HARNESS}/node_modules/.pnpm/@testing-library+react@16.3_b0bbe147884ef4cbbf95e64a97c782e8/node_modules/@testing-library/react/dist/index.js`,
  },
]

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
    alias: [...VENDOR_ALIASES, ...BROWSER_ALIASES],
  },
  // Harness sources use standard TypeScript decorators that need the shared
  // transform plugin.
  plugins: [standardDecoratorPlugin()],
  test: { include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'] },
})
