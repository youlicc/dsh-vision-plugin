/**
 * The `describe_image` tool: read a local PNG/JPEG/WebP/GIF file, durably
 * commit it through the attachment service, describe it through the vision
 * bridge, and return the description as text. The file is read with node's
 * own fs (the paste-to-path temp files live outside the workspace), and the
 * image never enters the routed model's request as an image block, so a
 * text-only model can use it directly.
 * @module @dsh-external/dsh-vision-plugin/describe-image
 */

import { basename, extname } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { DescribeService } from './describe.ts'

/** Extensions `describe_image` accepts; magic-byte validation at the attachment service stays authoritative. */
const IMAGE_EXTENSIONS: Readonly<Record<string, ImageMediaType>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** The canonical outcome declared by the `describe_image` output schema. */
export interface DescribeImageValue {
  path: string
  question: string
  description: string
}

/**
 * Register the `describe_image` tool into the given context.
 * @param ctx - the plugin context; execution uses the mounted attachment and llm services.
 * @param describe - the shared vision bridge.
 */
export function applyDescribeImageTool(ctx: Context, describe: DescribeService): void {
  ctx.tools.register(defineTool({
    name: 'describe_image',
    description: 'Read a PNG/JPEG/WebP/GIF image file and describe its content using a vision model, returning the description as text. Use whenever a message references an image the current model cannot see: a local file path (workspace or pasted temp path).',
    parameters: {
      file_path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the image file.',
      },
      question: {
        type: 'string',
        description: 'Optional question for the vision model.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          question: { type: 'string', required: true },
          description: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<path>${value.path}</path>\n<question>${value.question}</question>\n<content>\n${value.description}\n</content>`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const filePath = args.file_path.trim()
      if (filePath.length === 0) throw new Error('file_path must be a non-empty string')
      const mediaType = IMAGE_EXTENSIONS[extname(filePath).toLowerCase()]
      if (mediaType === undefined) {
        throw new Error(`cannot describe "${filePath}": describe_image only accepts PNG/JPEG/WebP/GIF paths`)
      }
      const data = await readFile(filePath, { signal: exec.signal })
      const question = typeof args.question === 'string' && args.question.trim().length > 0
        ? args.question.trim()
        : '请详细描述这张图片的内容'
      let outcome
      try {
        outcome = await describe.describe(data, mediaType, question, basename(filePath), exec.signal)
      } catch (error: unknown) {
        if (!(error instanceof AttachmentError) || error.code !== 'IMAGE_TYPE_MISMATCH') throw error
        const extension = extname(filePath).toLowerCase()
        throw new Error(
          `cannot describe "${filePath}": the ${extension} extension declares ${mediaType}, but the bytes use a different image format; rename the file to match its actual format if it is PNG/JPEG/WebP/GIF, or convert it to one of those formats`,
          { cause: error },
        )
      }
      const value: DescribeImageValue = {
        path: filePath,
        question,
        description: outcome.text,
      }
      return value
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Describe image ${args.file_path}`,
        kind: 'read',
        locations: [{ path: args.file_path }],
      }
    },
  }))
}
