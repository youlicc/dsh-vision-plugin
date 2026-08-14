/**
 * Paste-to-path: the host half of the browser paste interception. The client
 * POSTs pasted image bytes here; they land as a private (0600) file in a
 * fresh unpredictable temp dir and the returned path is inserted into the
 * composer as text, so a text-only model never trips image admission. A GET
 * verdict tells the client whether to take a paste over at all: only a model
 * whose metadata positively confirms text-only is taken over, so vision
 * models keep their native thumbnail paste.
 * @module @dsh-external/dsh-vision-plugin/paste
 */

import type { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readdir, rm, stat as statFile, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Config } from './config.ts'

/** Magic-byte sniffs for the accepted raster formats, with their extensions. */
const SNIFFS: readonly { ext: string; test: (buffer: Buffer) => boolean }[] = [
  { ext: '.png', test: buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: '.jpg', test: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  { ext: '.webp', test: buffer => buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP' },
  { ext: '.gif', test: buffer => buffer.length >= 6 && buffer.subarray(0, 6).toString('latin1') === 'GIF89a' },
]

/**
 * Persist one pasted image as a private temp file.
 * @param data - the image bytes.
 * @param maxBytes - the deployment's upload cap.
 * @returns the absolute path of the written file.
 * @throws when the bytes are not a recognized image or exceed the cap.
 */
export async function handlePasteBytes(data: Uint8Array, maxBytes: number): Promise<string> {
  if (data.byteLength > maxBytes) {
    throw new Error(`image over the ${maxBytes}-byte limit`)
  }
  const buffer = Buffer.from(data)
  const sniff = SNIFFS.find(candidate => candidate.test(buffer))
  if (sniff === undefined) {
    throw new Error('not a recognized image (png/jpeg/webp/gif)')
  }
  const dir = await mkdtemp(join(tmpdir(), 'dsh-vision-paste-'))
  const file = join(dir, `paste-${Date.now()}${sniff.ext}`)
  await writeFile(file, buffer, { mode: 0o600 })
  return file
}

/** The temp-dir prefix owned by this plugin's paste intake. */
const PASTE_PREFIX = 'dsh-vision-paste-'

/**
 * Delete every paste temp directory whose files are older than the retention
 * window. Pastes are one-shot inputs: once the path text reached the composer
 * the directory has no further use, so leaving it behind would accumulate
 * stale images that an agent searching for "the current paste" can mistake
 * for a fresh one.
 * @param retentionMs - directories whose newest file is older than this are removed.
 * @param root - the temp root to sweep (defaults to the OS temp dir).
 * @returns the number of removed directories.
 */
export async function cleanupStalePasteDirs(retentionMs: number, root = tmpdir()): Promise<number> {
  const cutoff = Date.now() - retentionMs
  let removed = 0
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(PASTE_PREFIX)) continue
    const dir = join(root, entry.name)
    let newest = 0
    for (const file of await readdir(dir)) {
      try {
        const stat = await statFile(join(dir, file))
        if (stat.mtimeMs > newest) newest = stat.mtimeMs
      } catch {
        // A file vanishing mid-scan is fine; the directory age decides below.
      }
    }
    if (newest < cutoff) {
      await rm(dir, { recursive: true, force: true })
      removed += 1
    }
  }
  return removed
}

/**
 * Whether the client should take a paste over for the currently selected
 * model label. Only a model whose metadata positively confirms text-only is
 * taken over; vision models and unknown labels keep their native paste.
 * @param ctx - the plugin context carrying the llm service.
 * @param label - the model-selector label text from the browser.
 * @returns `true` when the label names a confirmed text-only model.
 */
export async function pasteTakeoverVerdict(ctx: Context, label: string): Promise<boolean> {
  if (typeof label !== 'string' || label.trim() === '') return false
  const llm = ctx.get('llm')
  if (llm === undefined) return false
  const lowered = label.toLowerCase()
  let matchedAny = false
  for (const provider of llm.listProviders()) {
    let models: readonly { name?: string; id: string; inputModalities?: readonly string[] }[]
    try {
      models = await llm.listModels(provider.id)
    } catch {
      return false
    }
    for (const model of models) {
      for (const candidate of [model.name, model.id]) {
        if (typeof candidate !== 'string' || candidate.length === 0) continue
        if (!lowered.includes(candidate.toLowerCase())) continue
        const modalities = model.inputModalities
        if (modalities === undefined || modalities.includes('image')) return false
        if (candidate.length >= 3) matchedAny = true
      }
    }
  }
  return matchedAny
}

/**
 * Register the paste route on the web server. Never throws: a missing
 * webServer (headless) leaves the plugin a tool-only bridge.
 * @param ctx - the web-server scoped context.
 * @param host - the plugin context, for verdict resolution.
 * @param config - the resolved plugin configuration.
 */
export function registerPasteRoute(ctx: Context, host: Context, config: Config): void {
  if (!config.pasteToPath) return
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  // Sweep stale paste dirs at mount (previous runs may have left some) and
  // after every accepted paste.
  void cleanupStalePasteDirs(config.pasteRetentionMs)
  webServer.register({
    kind: 'exact',
    path: '/vision-plugin/paste',
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === 'GET') {
        const label = new URL(req.url ?? '', 'http://localhost').searchParams.get('model') ?? ''
        try {
          const takeover = await pasteTakeoverVerdict(host, label)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ takeover }))
        } catch (error: unknown) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }))
        }
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      try {
        const chunks: Uint8Array[] = []
        let total = 0
        for await (const chunk of req) {
          total += chunk.length
          if (total > config.pasteMaxBytes) {
            res.writeHead(413, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: `image over the ${config.pasteMaxBytes}-byte limit` }))
            res.destroy()
            return
          }
          chunks.push(chunk)
        }
        const path = await handlePasteBytes(Buffer.concat(chunks), config.pasteMaxBytes)
        void cleanupStalePasteDirs(config.pasteRetentionMs)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ path }))
      } catch (error: unknown) {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error instanceof Error ? error.message : error) }))
      }
    },
  })
}
