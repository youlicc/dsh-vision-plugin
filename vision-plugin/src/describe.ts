/**
 * The provider-agnostic vision bridge: durably commits one image through the
 * attachment service, calls the configured provider/model chain through
 * `ctx.llm`, and returns the model's description text. Concurrent calls for
 * identical bytes share a single in-flight task.
 * @module @dsh-external/dsh-vision-plugin/describe
 */

import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage, LlmError } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { Config } from './config.ts'
import type { VisionModelSelection } from './vision-model-selection.ts'
import type { VisionRoute } from './vision-models.ts'
import { FREE_VISION_MODELS } from './vision-models.ts'

/** Collect one stream into its assembled content blocks, failing on stream errors. */
async function collectText(stream: AsyncIterable<StreamChunk>): Promise<ContentBlock[]> {
  const assembler = new BlockAssembler()
  for await (const chunk of stream) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'error') throw new LlmError(finish.failure.message, finish.failure.code)
  if (finish.kind === 'aborted') throw new LlmError('vision call aborted', 'ABORTED')
  return assembler.blocks()
}

/** The plugin's model-visible source tag for recognition messages. */
export const VISION_SOURCE = { kind: 'plugin', plugin: 'dsh-vision-plugin' } as const

/** One completed recognition: the verified reference plus the description text. */
export interface DescribeOutcome {
  /** The durable reference committed for the image. */
  ref: ImageAttachmentRef
  /** The model's description text. */
  text: string
}

export class DescribeService {
  private readonly inFlight = new Map<string, Promise<DescribeOutcome>>()

  constructor(
    private readonly ctx: Context,
    private readonly config: Config,
    private readonly selection?: VisionModelSelection,
  ) {}

  /**
   * Describe one image, sharing one in-flight task across concurrent callers
   * with identical bytes.
   * @param data - the encoded image bytes.
   * @param mediaType - the declared media type (validated against the bytes).
   * @param question - the model-facing question (Chinese by default).
   * @param name - optional display name for the durable reference.
   * @param signal - optional cancellation.
   * @returns the committed reference and the description text.
   */
  describe(
    data: Uint8Array,
    mediaType: ImageAttachmentRef['mediaType'],
    question: string,
    name?: string,
    signal?: AbortSignal,
  ): Promise<DescribeOutcome> {
    const key = createHash('sha256').update(data).digest('hex')
    const existing = this.inFlight.get(key)
    if (existing !== undefined) return existing
    const task = this.describeFresh(data, mediaType, question, name, signal).finally(() => {
      this.inFlight.delete(key)
    })
    this.inFlight.set(key, task)
    return task
  }

  private async describeFresh(
    data: Uint8Array,
    mediaType: ImageAttachmentRef['mediaType'],
    question: string,
    name: string | undefined,
    signal?: AbortSignal,
  ): Promise<DescribeOutcome> {
    const attachments = this.ctx.get('attachments')
    if (attachments === undefined) throw new Error('no attachment service is mounted')
    const maxBytes = this.config.maxInputBytes > 0
      ? this.config.maxInputBytes
      : attachments.imageLimits.maxImageBytes
    if (data.byteLength > maxBytes) {
      throw new Error(`image exceeds the ${maxBytes}-byte recognition limit`)
    }
    // Commit durably so the vision call can reference the image through the
    // harness's only image transport (durable attachment refs).
    const ref = await attachments.saveImage({
      data,
      mediaType,
      ...name === undefined ? {} : { name },
    })
    // Resolve the vision route chain: explicit config wins, then the menu
    // selection (plus the same provider's remaining free models as fallback),
    // then fail with a clear message.
    const routes = this.resolveRoutes()
    if (routes.length === 0) {
      throw new Error('未配置视觉模型供应商：请在插件配置中设置 provider/models，或在 composer 的“视觉模型”菜单中选择一个免费视觉模型')
    }
    const failures: string[] = []
    for (const route of routes) {
      signal?.throwIfAborted()
      try {
        const text = await this.callModel(ref, question, route, signal)
        if (text.trim().length > 0) return { ref, text }
        failures.push(`${route.provider}/${route.model}: empty description`)
      } catch (error: unknown) {
        // An external cancellation is terminal: never fall through to the
        // next model after the caller gave up.
        if (signal?.aborted) throw error
        failures.push(`${route.provider}/${route.model}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`all vision models failed: ${failures.join('; ')}`)
  }

  /** The ordered route chain: explicit config, else menu selection, else empty. */
  private resolveRoutes(): readonly VisionRoute[] {
    if (this.config.provider !== undefined && this.config.models !== undefined && this.config.models.length > 0) {
      return this.config.models.map(model => ({ provider: this.config.provider!, model }))
    }
    const selected = this.selection?.currentRoute()
    if (selected === undefined) return []
    const sameProvider = (FREE_VISION_MODELS[selected.provider] ?? [])
      .filter(model => model !== selected.model)
      .map(model => ({ provider: selected.provider, model }))
    return [selected, ...sameProvider]
  }

  private async callModel(
    ref: ImageAttachmentRef,
    question: string,
    route: VisionRoute,
    signal?: AbortSignal,
  ): Promise<string> {
    const llm = this.ctx.get('llm')
    if (llm === undefined) throw new Error('no llm service is mounted')
    // Per-model deadline: the caller's signal cancels immediately (no
    // timeout error), while a model that exceeds `timeoutMs` is aborted and
    // reported as a TIMEOUT the fallback chain may recover from.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs)
    const forward = (): void => controller.abort()
    signal?.addEventListener('abort', forward, { once: true })
    try {
      const prepared = await llm.prepareCall(
        { provider: route.provider, model: route.model, maxTokens: this.config.maxOutputTokens },
        controller.signal,
      )
      const options: GenerateOptions = {
        ...prepared.config,
        system: this.config.systemPrompt,
        messages: [createUserMessage({
          content: [
            { type: 'text', text: question },
            { type: 'image', attachment: ref },
          ],
          source: VISION_SOURCE,
        })],
        signal: controller.signal,
      }
      const blocks = await collectText(prepared.stream(options))
      return blocks
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('')
    } catch (error: unknown) {
      // The deadline fired (and the caller did not cancel): report TIMEOUT so
      // the chain moves on. Any other failure propagates as-is.
      if (controller.signal.aborted && signal?.aborted !== true) {
        throw new LlmError(`vision model "${route.model}" timed out after ${this.config.timeoutMs}ms`, 'TIMEOUT')
      }
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    }
  }
}
