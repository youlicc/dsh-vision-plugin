/**
 * Wrapped vision providers: for each text-only provider route, register a
 * mirror provider whose model metadata declares image input. Selecting a
 * `(vision)` model lets a text-only conversation accept a native thumbnail
 * paste (image admission passes), while the wrapper's stream rewrites image
 * blocks into vision descriptions before delegating to the real route.
 * @module @dsh-external/dsh-vision-plugin/wrapped-provider
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  AdapterRegistrationHandle,
  ContentBlock,
  GenerateOptions,
  LlmModelInfo,
  LlmProviderInfo,
  LlmResolvedModelInfo,
  Message,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { DescribeService } from './describe.ts'

/** The model-visible text replacing one image block in the delegated request. */
export function imageDescriptionText(name: string | undefined, description: string, attachmentId?: string): string {
  const label = name === undefined ? '图片' : name
  const guidance = attachmentId === undefined
    ? '无需再寻找或复核本地图片文件'
    : `如需复核原图请调用 describe_attachment（attachment_id: ${attachmentId}），不要搜索本地文件`
  return `[图片 ${label} 的识别结果（${guidance}）]\n${description}`
}

/**
 * The mirror adapter for one real text-only provider. Model metadata
 * declares image input (so admission and `read_image`-style gates pass);
 * `stream` rewrites image blocks into description text and delegates the
 * rewritten request to the real route through the llm service (a hand-built
 * call, so the loop's log-reconstruction invariant does not apply to the
 * rewritten messages).
 */
export class WrappedVisionAdapter extends LlmAdapter {
  private readonly descriptionCache = new Map<string, Promise<string>>()

  constructor(
    private readonly host: Context,
    private readonly describe: DescribeService,
    private readonly realProvider: string,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: `${this.realProvider} (vision)` }
  }

  override async listModels(): Promise<readonly LlmModelInfo[]> {
    const llm = this.host.get('llm')
    if (llm === undefined) return []
    const real = await llm.listModels(this.realProvider)
    return real
      .filter(model => model.inputModalities === undefined || !model.inputModalities.includes('image'))
      .map(model => ({
        provider: `${this.realProvider}-vision`,
        id: model.id,
        name: `${model.name ?? model.id} (vision)`,
        ...model.description === undefined ? {} : { description: model.description },
        inputModalities: ['text', 'image'],
      }))
  }

  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const llm = this.host.get('llm')
    if (llm === undefined) return { provider, id: model, name: model }
    // Forward the real model's full capability (reasoning, context window,
    // defaults), then widen the declared modalities with image.
    const info = await llm.resolveModelInfo(this.realProvider, model, signal)
    return {
      ...info,
      provider,
      name: info.name ?? model,
      inputModalities: [...(info.inputModalities ?? ['text']), 'image'],
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const rewritten = await this.rewriteMessages(options.messages, options.signal)
    const llm = this.host.get('llm')
    if (llm === undefined) throw new Error('no llm service is mounted')
    const delegated: GenerateOptions = {
      ...options,
      provider: this.realProvider,
      messages: rewritten,
    }
    yield* llm.stream(delegated)
  }

  private async rewriteMessages(
    messages: readonly Message[],
    signal?: AbortSignal,
  ): Promise<Message[]> {
    let changed = false
    const out: Message[] = []
    for (const message of messages) {
      const content = await this.rewriteBlocks(message.content, signal)
      if (content !== message.content) {
        out.push({ ...message, content })
        changed = true
      } else {
        out.push(message)
      }
    }
    return changed ? out : [...messages]
  }

  private async rewriteBlocks(
    blocks: readonly ContentBlock[],
    signal?: AbortSignal,
  ): Promise<ContentBlock[]> {
    // Kick off every top-level image recognition in parallel: the vision
    // chain is the long pole (free models queue 30-80s), and serializing N
    // images made a multi-image message stall for N times that before the
    // first token. A failed recognition degrades to a placeholder instead of
    // failing the whole request.
    const imageTasks: { index: number; promise: Promise<string> }[] = []
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!
      if (block.type === 'image' && block.attachment !== undefined) {
        imageTasks.push({
          index,
          promise: this.describeAttachment(block.attachment, signal),
        })
      }
    }
    const descriptions = new Map<number, string>()
    if (imageTasks.length > 0) {
      const settled = await Promise.allSettled(imageTasks.map(task => task.promise))
      for (let i = 0; i < settled.length; i += 1) {
        const outcome = settled[i]
        if (outcome === undefined) continue
        if (outcome.status === 'fulfilled') descriptions.set(imageTasks[i]!.index, outcome.value)
        else {
          descriptions.set(imageTasks[i]!.index, `（图片识别失败：${outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason)}）`)
        }
      }
    }

    let changed = false
    const out: ContentBlock[] = []
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]!
      if (block.type === 'image' && block.attachment !== undefined) {
        const description = descriptions.get(index)
        if (description !== undefined) {
          out.push({ type: 'text', text: imageDescriptionText(block.attachment.name, description, String(block.attachment.attachmentId)) })
          changed = true
          continue
        }
      }
      if (block.type === 'tool-result' && block.content !== undefined) {
        const content = await this.rewriteBlocks(block.content, signal)
        if (content !== block.content) {
          out.push({ ...block, content })
          changed = true
          continue
        }
      }
      out.push(block)
    }
    return changed ? out : [...blocks]
  }

  /** Describe one durable attachment, caching by content address. */
  private describeAttachment(ref: ImageAttachmentRef, signal?: AbortSignal): Promise<string> {
    const id = String(ref.attachmentId)
    const cached = this.descriptionCache.get(id)
    if (cached !== undefined) return cached
    const task = (async () => {
      const attachments = this.host.get('attachments')
      if (attachments === undefined) throw new Error('no attachment service is mounted')
      const stored = await attachments.readImage(ref, signal)
      const outcome = await this.describe.describe(
        stored.data,
        stored.ref.mediaType,
        '请详细描述这张图片的内容',
        stored.ref.name,
        signal,
      )
      return outcome.text
    })()
    // Failures are not cached: a later request may recover.
    const safe = task.catch((error: unknown) => {
      this.descriptionCache.delete(id)
      throw error
    })
    this.descriptionCache.set(id, safe)
    return safe
  }
}

/**
 * Register one mirror provider per text-only provider route, re-scanning when
 * the llm topology changes.
 * @param ctx - the plugin context.
 * @param describe - the shared vision bridge.
 * @param enabled - whether wrapping is configured on.
 * @returns a disposer removing every mirror registration.
 */
export function applyWrappedProviders(
  ctx: Context,
  describe: DescribeService,
  enabled: boolean,
): () => void {
  if (!enabled) return () => {}
  const handles = new Map<string, AdapterRegistrationHandle>()
  let disposed = false

  const scan = async (): Promise<void> => {
    if (disposed) return
    const llm = ctx.get('llm')
    if (llm === undefined) return
    const textOnly: string[] = []
    for (const provider of llm.listProviders()) {
      if (handles.has(provider.id)) continue
      try {
        const models = await llm.listModels(provider.id)
        if (models.some(model => model.inputModalities !== undefined && !model.inputModalities.includes('image'))) {
          textOnly.push(provider.id)
        }
      } catch {
        // A provider whose catalog fails is left for a later scan.
      }
    }
    for (const realProvider of textOnly) {
      const wrappedId = `${realProvider}-vision`
      try {
        const handle = llm.registerAdapter([wrappedId], new WrappedVisionAdapter(ctx, describe, realProvider))
        handles.set(realProvider, handle)
      } catch {
        // A route collision (another plugin owning the id) is left as-is.
      }
    }
  }

  // The first scan is deferred: providers mounted after this plugin (pi-ai
  // routes land after settings load) register through the same event below.
  const initial = setTimeout(() => { void scan() }, 0)
  // `llm/adapters-updated` is a documented-but-untyped notification; the
  // narrow ctx.on overloads do not know it, so call through a string-loose
  // face.
  const onUpdated: () => void = (ctx.on as unknown as (name: string, listener: () => void) => () => void)(
    'llm/adapters-updated',
    () => { void scan() },
  )

  return () => {
    disposed = true
    clearTimeout(initial)
    onUpdated()
    for (const handle of handles.values()) handle()
    handles.clear()
  }
}
