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
    const failures: string[] = []
    for (const model of this.config.models) {
      signal?.throwIfAborted()
      try {
        const text = await this.callModel(ref, question, model, signal)
        if (text.trim().length > 0) return { ref, text }
        failures.push(`${model}: empty description`)
      } catch (error: unknown) {
        // An external cancellation is terminal: never fall through to the
        // next model after the caller gave up.
        if (signal?.aborted) throw error
        failures.push(`${model}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`all vision models failed (${this.config.provider}): ${failures.join('; ')}`)
  }

  private async callModel(
    ref: ImageAttachmentRef,
    question: string,
    model: string,
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
        { provider: this.config.provider, model, maxTokens: this.config.maxOutputTokens },
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
        throw new LlmError(`vision model "${model}" timed out after ${this.config.timeoutMs}ms`, 'TIMEOUT')
      }
      throw error
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    }
  }
}
