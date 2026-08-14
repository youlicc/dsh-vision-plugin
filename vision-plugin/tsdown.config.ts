import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  dts: false,
  clean: false,
  fixedExtension: false,
  // The cordis framework and every dsh package resolve at runtime from the
  // host profile tree, never from this repo's install.
  external: [/^@deepseek-ai\//],
})
