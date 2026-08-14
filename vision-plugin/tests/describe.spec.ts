/**
 * DescribeService behavior: fallback across the configured model chain,
 * in-flight deduplication by bytes, byte-limit enforcement, and empty-output
 * retry. The llm service is real (LlmRuntime + scripted adapters);
 * attachments are mocked.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { DescribeService } from '../src/describe.ts'

const REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'e'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 4,
  width: 2,
  height: 2,
}

const PNG_BYTES = Uint8Array.of(1, 2, 3, 4)

const CONFIG = {
  provider: 'vision',
  models: ['first', 'second', 'third'],
  systemPrompt: 'describe it',
  maxOutputTokens: 256,
  timeoutMs: 1000,
  maxInputBytes: 0,
  pasteMaxBytes: 1024,
  pasteRetentionMs: 86400000,
  pasteToPath: true,
  wrappedModels: true,
}

function textChunks(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

class ScriptedAdapter extends LlmAdapter {
  calls: string[] = []

  constructor(private readonly behavior: Record<string, () => StreamChunk[] | Error | 'hang'>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options.model)
    const entry = this.behavior[options.model]
    if (entry === undefined) throw new Error(`unexpected model ${options.model}`)
    const outcome = entry()
    if (outcome === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new Error('aborted'))
          return
        }
        options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      return
    }
    if (outcome instanceof Error) throw outcome
    for (const chunk of outcome) yield chunk
  }
}

function harness(behavior: Record<string, () => StreamChunk[] | Error | 'hang'>) {
  const ctx = new Context()
  const adapter = new ScriptedAdapter(behavior)
  void new LlmRuntime(ctx)
  ctx.llm.registerAdapter(['vision'], adapter)
  const saveImage = vi.fn(async () => REF)
  ctx.provide('attachments', {
    imageLimits: { maxImageBytes: 1024, maxImagesPerMessage: 4, maxMessageImageBytes: 4096, maxImagePixels: 100, mediaTypes: ['image/png'] },
    saveImage,
  } as never)
  return { ctx, adapter, saveImage }
}

describe('DescribeService', () => {
  it('commits the image and returns the first non-empty description', async () => {
    const { ctx, adapter, saveImage } = harness({
      'first': () => new Error('RATE_LIMIT'),
      'second': () => textChunks('一只猫在草地上'),
    })
    const service = new DescribeService(ctx, CONFIG)
    const outcome = await service.describe(PNG_BYTES, 'image/png', '这是什么', 'cat.png')
    expect(outcome.text).toBe('一只猫在草地上')
    expect(outcome.ref).toEqual(REF)
    expect(saveImage).toHaveBeenCalledWith({ data: PNG_BYTES, mediaType: 'image/png', name: 'cat.png' })
    expect(adapter.calls).toEqual(['first', 'second'])
    await ctx.fiber.dispose()
  })

  it('fails with a summary when every model fails', async () => {
    const { ctx, adapter } = harness({
      'first': () => new Error('RATE_LIMIT'),
      'second': () => new Error('TIMEOUT'),
      'third': () => new Error('UNKNOWN_MODEL'),
    })
    const service = new DescribeService(ctx, CONFIG)
    await expect(service.describe(PNG_BYTES, 'image/png', 'q')).rejects.toThrow(
      /all vision models failed \(vision\): first: RATE_LIMIT; second: TIMEOUT; third: UNKNOWN_MODEL/,
    )
    expect(adapter.calls).toEqual(['first', 'second', 'third'])
    await ctx.fiber.dispose()
  })

  it('shares one in-flight task across concurrent callers with identical bytes', async () => {
    const { ctx, adapter } = harness({
      'first': () => textChunks('共享结果'),
    })
    const service = new DescribeService(ctx, CONFIG)
    const [a, b] = await Promise.all([
      service.describe(PNG_BYTES, 'image/png', 'q1'),
      service.describe(PNG_BYTES, 'image/png', 'q2'),
    ])
    expect(a.text).toBe('共享结果')
    expect(b.text).toBe('共享结果')
    expect(adapter.calls).toEqual(['first'])
    await ctx.fiber.dispose()
  })

  it('retries the next model after an empty description', async () => {
    const { ctx, adapter } = harness({
      'first': () => textChunks(''),
      'second': () => textChunks('有内容'),
    })
    const service = new DescribeService(ctx, CONFIG)
    const outcome = await service.describe(PNG_BYTES, 'image/png', 'q')
    expect(outcome.text).toBe('有内容')
    expect(adapter.calls).toEqual(['first', 'second'])
    await ctx.fiber.dispose()
  })

  it('enforces the byte cap when configured', async () => {
    const { ctx } = harness({ 'first': () => textChunks('x') })
    const service = new DescribeService(ctx, { ...CONFIG, maxInputBytes: 2 })
    await expect(service.describe(PNG_BYTES, 'image/png', 'q')).rejects.toThrow(
      /exceeds the 2-byte recognition limit/,
    )
    await ctx.fiber.dispose()
  })

  it('times out a hanging model and falls through to the next', async () => {
    const { ctx, adapter } = harness({
      'first': () => 'hang',
      'second': () => textChunks('兜底结果'),
    })
    const service = new DescribeService(ctx, { ...CONFIG, timeoutMs: 50 })
    const outcome = await service.describe(PNG_BYTES, 'image/png', 'q')
    expect(outcome.text).toBe('兜底结果')
    expect(adapter.calls).toEqual(['first', 'second'])
    await ctx.fiber.dispose()
  })

  it('reports TIMEOUT when every model hangs', async () => {
    const { ctx, adapter } = harness({
      'first': () => 'hang',
      'second': () => 'hang',
      'third': () => 'hang',
    })
    const service = new DescribeService(ctx, { ...CONFIG, timeoutMs: 40 })
    await expect(service.describe(PNG_BYTES, 'image/png', 'q')).rejects.toThrow(
      /all vision models failed \(vision\): first: vision model "first" timed out after 40ms; second: vision model "second" timed out after 40ms; third: vision model "third" timed out after 40ms/,
    )
    expect(adapter.calls).toEqual(['first', 'second', 'third'])
    await ctx.fiber.dispose()
  })

  it('does not fall through after an external cancellation', async () => {
    const { ctx, adapter } = harness({ 'first': () => 'hang' })
    const service = new DescribeService(ctx, CONFIG)
    const controller = new AbortController()
    const promise = service.describe(PNG_BYTES, 'image/png', 'q', undefined, controller.signal)
    await new Promise(resolve => setTimeout(resolve, 20))
    controller.abort()
    await expect(promise).rejects.toThrow(/aborted/i)
    expect(adapter.calls).toEqual(['first'])
    await ctx.fiber.dispose()
  })
})
