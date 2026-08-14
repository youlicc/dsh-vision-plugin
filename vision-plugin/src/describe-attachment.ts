/**
 * The `describe_attachment` tool: re-read one durable image by its attachment
 * id (from a wrapped-`(vision)` message's auto-recognition text) and describe
 * it through the vision bridge. This is the channel a text-only model uses to
 * inspect the original pixels when it needs to verify something the brief
 * description glossed over — it reads the content-addressed attachment store
 * directly, no dsh source changes required.
 * @module @dsh-external/dsh-vision-plugin/describe-attachment
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { DescribeService } from './describe.ts'
import { readAttachmentById } from './attachment-reader.ts'

/** Default model-facing question for one recognition call. */
export const DEFAULT_QUESTION = '请详细描述这张图片的内容'

/** The canonical outcome declared by the `describe_attachment` output schema. */
export interface DescribeAttachmentValue {
  attachmentId: string
  question: string
  description: string
}

/**
 * Register the `describe_attachment` tool into the given context.
 * @param ctx - the plugin context.
 * @param describe - the shared vision bridge.
 */
export function applyDescribeAttachmentTool(ctx: Context, describe: DescribeService): void {
  ctx.tools.register(defineTool({
    name: 'describe_attachment',
    description: 'Re-read an attached image by its attachment_id (sha256:…) and describe it using a vision model, returning the description as text. Use when a message references an image by attachment id and you need to inspect its content precisely.',
    parameters: {
      attachment_id: {
        type: 'string',
        required: true,
        description: 'The durable attachment id (sha256:…) carried in the message.',
      },
      question: {
        type: 'string',
        description: `Optional question for the vision model; defaults to "${DEFAULT_QUESTION}".`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string', required: true },
          question: { type: 'string', required: true },
          description: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `<attachment_id>${value.attachmentId}</attachment_id>\n<question>${value.question}</question>\n<content>\n${value.description}\n</content>`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const attachmentId = args.attachment_id.trim()
      if (attachmentId.length === 0) throw new Error('attachment_id must be a non-empty string')
      const question = typeof args.question === 'string' && args.question.trim().length > 0
        ? args.question.trim()
        : DEFAULT_QUESTION
      const stored = await readAttachmentById(attachmentId)
      const outcome = await describe.describe(stored.data, stored.mediaType, question, undefined, exec.signal)
      const value: DescribeAttachmentValue = {
        attachmentId,
        question,
        description: outcome.text,
      }
      return value
    },
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: `Describe image ${args.attachment_id}`,
        kind: 'read',
      }
    },
  }))
}
