/**
 * Paste-to-path host logic: byte sniffing + private temp file persistence,
 * size capping, and the takeover verdict against real model metadata.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { LlmModelInfo } from '@deepseek-ai/dsh-llm'
import { cleanupStalePasteDirs, handlePasteBytes, pasteTakeoverVerdict } from '../src/paste.ts'

/** 1x1 PNG (valid signature, IHDR, IDAT). */
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('handlePasteBytes', () => {
  it.skipIf(process.platform === 'win32')('persists a sniffed image as a private temp file and returns its path', async () => {
    const path = await handlePasteBytes(PNG, 1024)
    dirs.push(path)
    expect(path).toMatch(/dsh-vision-paste-.*\\paste-\d+\.png$/)
    const data = await readFile(path)
    expect([...data]).toEqual([...PNG])
    const mode = (await stat(path)).mode
    // 0600: owner read/write only (no group/other bits). Windows maps the
    // mode differently, so the bit assertion is POSIX-only.
    expect(mode & 0o077).toBe(0)
  })

  it('rejects unrecognized bytes', async () => {
    await expect(handlePasteBytes(Uint8Array.of(1, 2, 3, 4), 1024))
      .rejects.toThrow('not a recognized image')
  })

  it('rejects bytes over the cap', async () => {
    await expect(handlePasteBytes(PNG, 4)).rejects.toThrow('image over the 4-byte limit')
  })

  it('sniffs jpeg, webp and gif as well', async () => {
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])
    const webp = Uint8Array.from(Buffer.concat([
      Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'),
    ]))
    const gif = Uint8Array.from(Buffer.from('GIF89a'))
    for (const [bytes, suffix] of [[jpeg, '.jpg'], [webp, '.webp'], [gif, '.gif']] as const) {
      const path = await handlePasteBytes(bytes as Uint8Array, 1024)
      dirs.push(path)
      expect(path).toMatch(new RegExp(`paste-\\d+\\${suffix}$`))
    }
  })
})

class CatalogAdapter extends LlmAdapter {
  constructor(private readonly models: readonly LlmModelInfo[]) {
    super()
  }

  override providerInfo(provider: string): { id: string; name: string } {
    return { id: provider, name: provider }
  }

  override listModels(): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(this.models)
  }

  override resolveModel(provider: string, model: string) {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async *stream(): AsyncIterable<never> {
    // Verdict tests never stream.
  }
}

function verdictHarness(models: readonly LlmModelInfo[]) {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  ctx.llm.registerAdapter(['mock'], new CatalogAdapter(models))
  return ctx
}

describe('pasteTakeoverVerdict', () => {
  it('takes over a label naming a confirmed text-only model', async () => {
    const ctx = verdictHarness([
      { provider: 'mock', id: 'deepseek-chat', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
      { provider: 'mock', id: 'gemma', name: 'Gemma Vision', inputModalities: ['text', 'image'] },
    ])
    await expect(pasteTakeoverVerdict(ctx, 'DeepSeek-V4-Flash (modlens vision)')).resolves.toBe(true)
    await ctx.fiber.dispose()
  })

  it('refuses when the label names a vision model', async () => {
    const ctx = verdictHarness([
      { provider: 'mock', id: 'deepseek-chat', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
      { provider: 'mock', id: 'gemma', name: 'Gemma Vision', inputModalities: ['text', 'image'] },
    ])
    await expect(pasteTakeoverVerdict(ctx, 'Gemma Vision')).resolves.toBe(false)
    await ctx.fiber.dispose()
  })

  it('refuses unknown or empty labels', async () => {
    const ctx = verdictHarness([
      { provider: 'mock', id: 'deepseek-chat', name: 'DeepSeek-V4-Flash', inputModalities: ['text'] },
    ])
    await expect(pasteTakeoverVerdict(ctx, '')).resolves.toBe(false)
    await expect(pasteTakeoverVerdict(ctx, 'no-such-model')).resolves.toBe(false)
    await ctx.fiber.dispose()
  })

  it('refuses models with undeclared modalities (conservative)', async () => {
    const ctx = verdictHarness([
      { provider: 'mock', id: 'legacy', name: 'Legacy Chat' },
    ])
    await expect(pasteTakeoverVerdict(ctx, 'Legacy Chat')).resolves.toBe(false)
    await ctx.fiber.dispose()
  })
})

describe('cleanupStalePasteDirs', () => {
  it('removes only paste dirs whose files are older than the retention window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-vision-sweep-'))
    dirs.push(root)
    const oldDir = join(root, 'dsh-vision-paste-old')
    const freshDir = join(root, 'dsh-vision-paste-fresh')
    const otherDir = join(root, 'other-app')
    await mkdir(oldDir, { recursive: true })
    await mkdir(freshDir, { recursive: true })
    await mkdir(otherDir, { recursive: true })
    await writeFile(join(oldDir, 'paste.png'), PNG)
    await writeFile(join(freshDir, 'paste.png'), PNG)
    await writeFile(join(otherDir, 'data.txt'), 'x')
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000)
    await utimes(join(oldDir, 'paste.png'), old, old)

    const removed = await cleanupStalePasteDirs(60 * 60 * 1000, root)

    expect(removed).toBe(1)
    await expect(access(join(oldDir, 'paste.png'))).rejects.toThrow()
    await expect(access(join(freshDir, 'paste.png'))).resolves.toBeUndefined()
    await expect(access(join(otherDir, 'data.txt'))).resolves.toBeUndefined()
  })

  it('removes empty paste dirs (failed or interrupted uploads) and ignores unrelated directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-vision-sweep2-'))
    dirs.push(root)
    const empty = join(root, 'dsh-vision-paste-empty')
    await mkdir(empty, { recursive: true })
    const other = join(root, 'other-app')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'data.txt'), 'x')
    const removed = await cleanupStalePasteDirs(1000, root)
    // The empty paste dir is swept too (an upload that never wrote a file is
    // pure residue); the unrelated directory is left alone.
    expect(removed).toBe(1)
    await expect(access(empty)).rejects.toThrow()
    await expect(access(join(other, 'data.txt'))).resolves.toBeUndefined()
  })
})
