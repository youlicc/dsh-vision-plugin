/**
 * Wrapped vision provider behavior: model discovery filters text-only models
 * and widens them to image input, `stream` rewrites image blocks into
 * description text (cached per attachment) before delegating to the real
 * route, and the registration scan mounts one mirror provider per text-only
 * route.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import LlmRuntime, { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { DescribeService } from '../src/describe.ts'
import { applyWrappedProviders, imageDescriptionText, WrappedVisionAdapter } from '../src/wrapped-provider.ts'

/** 1x1 PNG (valid signature, IHDR, IDAT). */
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))

/** 3x3 PNG, different bytes from {@link PNG} so content addressing keeps them apart. */
const PNG3 = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAIAAADZSiLoAAAAEElEQVR4nGP4z8AAQQxYWACPjgj4kWPEuQAAAABJRU5ErkJggg==',
  'base64',
))

const CONFIG = {
  provider: 'vision',
  models: ['vision-model'],
  systemPrompt: 'describe',
  maxOutputTokens: 256,
  timeoutMs: 1000,
  maxInputBytes: 0,
  pasteMaxBytes: 1024,
  pasteRetentionMs: 86400000,
  pasteToPath: true,
  wrappedModels: true,
}

/** Records every delegated request it streams. */
class RecordAdapter extends LlmAdapter {
  delegated: GenerateOptions[] = []

  constructor(private readonly models: readonly LlmModelInfo[]) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const entry = this.models.find(candidate => candidate.id === model)
    return Promise.resolve({
      provider,
      id: model,
      name: entry?.name ?? model,
      ...entry?.inputModalities === undefined ? {} : { inputModalities: [...entry.inputModalities] },
    })
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.delegated.push(options)
    const text = '原始文本回复'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

class VisionAdapter extends LlmAdapter {
  calls = 0

  constructor(private readonly delayMs = 0) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }

  override async *stream(): AsyncIterable<StreamChunk> {
    this.calls += 1
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs))
    const text = '一只猫在草地上'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const TEXT_MODELS: readonly LlmModelInfo[] = [
  { provider: 'text-route', id: 'deepseek-chat', name: 'DeepSeek Chat', inputModalities: ['text'] },
  { provider: 'text-route', id: 'reasoner', name: 'DeepSeek Reasoner' },
]

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function harness(visionDelayMs = 0) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vision-wrap-'))
  homes.push(home)
  const ctx = new Context()
  void new LlmRuntime(ctx)
  ctx.llm.registerAdapter(['text-route'], new RecordAdapter(TEXT_MODELS))
  const vision = new VisionAdapter(visionDelayMs)
  ctx.llm.registerAdapter(['vision'], vision)
  await ctx.plugin(LocalAttachmentStore, { dshHome: home, maxImageBytes: 4096 })
  const describe = new DescribeService(ctx, CONFIG)
  return { ctx, describe, vision }
}

describe('WrappedVisionAdapter', () => {
  it('lists only text-only models, widened to image input with a (vision) name', async () => {
    const { ctx } = await harness()
    const adapter = new WrappedVisionAdapter(ctx, new DescribeService(ctx, CONFIG), 'text-route')
    const models = await adapter.listModels()
    expect(models).toEqual([
      { provider: 'text-route-vision', id: 'deepseek-chat', name: 'DeepSeek Chat (vision)', inputModalities: ['text', 'image'] },
      { provider: 'text-route-vision', id: 'reasoner', name: 'DeepSeek Reasoner (vision)', inputModalities: ['text', 'image'] },
    ])
    await ctx.fiber.dispose()
  })

  it('forwards the real capability and declares image input on resolve', async () => {
    const { ctx } = await harness()
    const adapter = new WrappedVisionAdapter(ctx, new DescribeService(ctx, CONFIG), 'text-route')
    const info = await adapter.resolveModel('text-route-vision', 'deepseek-chat')
    expect(info.provider).toBe('text-route-vision')
    expect(info.name).toBe('DeepSeek Chat')
    expect(info.inputModalities).toEqual(['text', 'image'])
    await ctx.fiber.dispose()
  })

  it('delegates text-only requests unchanged, on the real provider route', async () => {
    const { ctx } = await harness()
    const real = ctx.llm.listProviders().find(provider => provider.id === 'text-route')
    expect(real).toBeDefined()
    const adapter = new WrappedVisionAdapter(ctx, new DescribeService(ctx, CONFIG), 'text-route')
    const message = createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'text-route-vision', model: 'deepseek-chat', messages: [message],
    })) chunks.push(chunk)
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('rewrites image blocks into description text and delegates to the real route', async () => {
    const { ctx, describe, vision } = await harness()
    const saved = await ctx.attachments.saveImage({ data: PNG, mediaType: 'image/png', name: '猫.png' })
    const adapter = new WrappedVisionAdapter(ctx, describe, 'text-route')
    const message = createUserMessage({
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', attachment: saved },
      ],
      source: { kind: 'user' },
    })
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'text-route-vision', model: 'deepseek-chat', messages: [message],
    })) chunks.push(chunk)
    expect(vision.calls).toBe(1)
    expect(chunks.some(chunk => chunk.type === 'text-delta')).toBe(true)
    await ctx.fiber.dispose()
  })

  it('recognizes multiple images in parallel, not serially', async () => {
    const { ctx, describe, vision } = await harness(60)
    const first = await ctx.attachments.saveImage({ data: PNG, mediaType: 'image/png', name: 'a.png' })
    const second = await ctx.attachments.saveImage({ data: PNG3, mediaType: 'image/png', name: 'b.png' })
    const adapter = new WrappedVisionAdapter(ctx, describe, 'text-route')
    const message = createUserMessage({
      content: [
        { type: 'image', attachment: first },
        { type: 'image', attachment: second },
      ],
      source: { kind: 'user' },
    })
    const started = Date.now()
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter.stream({
      provider: 'text-route-vision', model: 'deepseek-chat', messages: [message],
    })) chunks.push(chunk)
    const elapsed = Date.now() - started
    // Serial would take ~120ms (2 x 60ms); parallel stays near one pass.
    expect(vision.calls).toBe(2)
    expect(elapsed).toBeLessThan(110)
    await ctx.fiber.dispose()
  })

  it('caches descriptions per attachment across requests', async () => {
    const { ctx, describe, vision } = await harness()
    const saved = await ctx.attachments.saveImage({ data: PNG, mediaType: 'image/png', name: '猫.png' })
    const adapter = new WrappedVisionAdapter(ctx, describe, 'text-route')
    const message = createUserMessage({
      content: [{ type: 'image', attachment: saved }],
      source: { kind: 'user' },
    })
    const run = async (): Promise<void> => {
      const chunks: StreamChunk[] = []
      for await (const chunk of adapter.stream({
        provider: 'text-route-vision', model: 'deepseek-chat', messages: [message],
      })) chunks.push(chunk)
    }
    await run()
    await run()
    expect(vision.calls).toBe(1)
    await ctx.fiber.dispose()
  })

  it('formats the description text block verbatim', () => {
    expect(imageDescriptionText('猫.png', '一只猫', 'sha256:abc'))
      .toBe('[图片 猫.png 的识别结果（如需复核原图请调用 describe_attachment（attachment_id: sha256:abc），不要搜索本地文件）]\n一只猫')
    expect(imageDescriptionText(undefined, '一只猫'))
      .toBe('[图片 图片 的识别结果（无需再寻找或复核本地图片文件）]\n一只猫')
  })
})

describe('applyWrappedProviders', () => {
  it('mounts a mirror provider per text-only route and disposes it', async () => {
    const { ctx, describe } = await harness()
    const dispose = applyWrappedProviders(ctx, describe, true)
    await new Promise(resolve => setTimeout(resolve, 20))
    const providers = ctx.llm.listProviders().map(provider => provider.id)
    expect(providers).toContain('text-route-vision')
    dispose()
    const after = ctx.llm.listProviders().map(provider => provider.id)
    expect(after).not.toContain('text-route-vision')
    await ctx.fiber.dispose()
  })

  it('does nothing when disabled', async () => {
    const { ctx, describe } = await harness()
    const dispose = applyWrappedProviders(ctx, describe, false)
    await new Promise(resolve => setTimeout(resolve, 20))
    const providers = ctx.llm.listProviders().map(provider => provider.id)
    expect(providers).not.toContain('text-route-vision')
    dispose()
    await ctx.fiber.dispose()
  })
})
