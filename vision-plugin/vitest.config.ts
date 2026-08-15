import { defineConfig } from 'vitest/config'

/**
 * Test configuration. All @deepseek-ai/* packages, react, and the test
 * toolchain now resolve from this package's own node_modules (npm
 * dependencies — no harness checkout required for development).
 */
export default defineConfig({
  test: { include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'] },
})
