/**
 * Plugin configuration: the vision provider route, the ordered fallback model
 * chain, and the recognition policy. All values are configurable from the
 * plugin entry's `config` (cordis.yml / settings), so switching providers is a
 * configuration change, never a code change.
 * @module @dsh-external/dsh-vision-plugin/config
 */

import z from '@deepseek-ai/schemastery'

/** Default ordered fallback chain: the OpenRouter free vision models recorded in the installed pi-ai catalog. */
export const DEFAULT_MODELS: readonly string[] = [
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-nano-12b-v2-vl:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
]

/** Resolved plugin configuration. */
export interface Config {
  /** Provider route serving the vision models (any registered llm route). */
  readonly provider: string
  /** Ordered fallback model chain; the first succeeding model wins. */
  models: string[]
  /** System prompt for the vision call. */
  readonly systemPrompt: string
  /** Maximum output tokens per vision call. */
  readonly maxOutputTokens: number
  /** Per-model call timeout in milliseconds. */
  readonly timeoutMs: number
  /** Maximum input bytes for one described image; 0 defers to the attachment service limit. */
  readonly maxInputBytes: number
  /** Maximum bytes accepted by the paste-to-path upload endpoint. */
  readonly pasteMaxBytes: number
  /** Whether the client paste interception (paste-to-path) is enabled. */
  readonly pasteToPath: boolean
  /** Whether text-only provider routes get `(vision)` mirror models (thumbnail paste). */
  readonly wrappedModels: boolean
}

export const Config: z<Config> = z.object({
  provider: z.string().default('openrouter'),
  models: z.array(z.string()).default([...DEFAULT_MODELS]),
  systemPrompt: z.string().default(
    '你是图像识别助手。请用中文详细、准确地描述这张图片的内容，包括主体、场景、文字（如有）与细节。',
  ),
  maxOutputTokens: z.natural().default(2048),
  timeoutMs: z.natural().default(60_000),
  maxInputBytes: z.natural().default(0),
  pasteMaxBytes: z.natural().default(20 * 1024 * 1024),
  pasteToPath: z.boolean().default(true),
  wrappedModels: z.boolean().default(true),
})
