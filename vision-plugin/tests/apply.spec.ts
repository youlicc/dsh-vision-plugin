/**
 * Composition tests over the assembled plugin: tool registration, and the
 * `describe_image` tool executing over a real temp image file with a mocked
 * attachment store and a scripted vision route.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply, Config, inject } from '../src/index.ts'

/** 1x1 PNG (valid signature, IHDR, IDAT). */
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))

const REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'f'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: PNG.byteLength,
  width: 1,
  height: 1,
}

class VisionAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }

  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const text = '一只猫在草地上晒太阳'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

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

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ToolRuntime, { mode: 'native' })
  ctx.llm.registerAdapter(['vision'], new VisionAdapter())
  const saveImage = vi.fn(async () => REF)
  ctx.provide('attachments', {
    imageLimits: {
      maxImageBytes: 4096, maxImagesPerMessage: 4, maxMessageImageBytes: 8192, maxImagePixels: 100,
      mediaTypes: ['image/png'],
    },
    saveImage,
  } as never)
  await ctx.plugin({ name: 'dsh-vision-plugin', apply, Config, inject }, CONFIG)
  return { ctx, saveImage }
}

async function tempImage(name = 'shot.png'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vision-tool-'))
  dirs.push(dir)
  const path = join(dir, name)
  await writeFile(path, PNG)
  return path
}

describe('dsh-vision-plugin composition', () => {
  it('registers the describe_image tool', async () => {
    const { ctx } = await harness()
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).toContain('describe_image')
    await ctx.fiber.dispose()
  })

  it('executes describe_image over a temp image and returns the description envelope', async () => {
    const { ctx, saveImage } = await harness()
    const path = await tempImage()
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('vision-call-1'),
      name: 'describe_image',
      arguments: { file_path: path },
    })
    const text = result.content
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    expect(text).toContain('一只猫在草地上晒太阳')
    expect(text).toContain('<path>')
    expect(saveImage).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('rejects non-image extensions and missing files', async () => {
    const { ctx } = await harness()
    const missDir = await mkdtemp(join(tmpdir(), 'dsh-vision-miss-'))
    dirs.push(missDir)
    const missing = join(missDir, 'x.png')
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('vision-call-2'),
      name: 'describe_image',
      arguments: { file_path: missing },
    })
    const text = result.content
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    expect(text).toMatch(/ENOENT|no such file|not found/i)
    const badExt = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('vision-call-3'),
      name: 'describe_image',
      arguments: { file_path: 'note.txt' },
    })
    const badText = badExt.content
      .filter(block => block.type === 'text')
      .map(block => block.type === 'text' ? block.text : '')
      .join('')
    expect(badText).toContain('only accepts PNG/JPEG/WebP/GIF')
    await ctx.fiber.dispose()
  })

  it('mounts without a web server (headless stays a tool-only bridge)', async () => {
    const { ctx } = await harness()
    // No webServer service was provided; apply must not throw.
    expect(ctx.tools.schemas().some(schema => schema.name === 'describe_image')).toBe(true)
    await ctx.fiber.dispose()
  })
})
