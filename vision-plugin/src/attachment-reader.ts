/**
 * Read one durable image attachment by content address alone. Attachments are
 * content-addressed files under `$DSH_HOME/attachments/v1/objects/<prefix>/<sha256>`
 * without an extension; the reader validates the id format, reads the file,
 * and recovers the media type from the bytes — the pure-plugin counterpart of
 * the (removed) `AttachmentStore.readImageById`, so a model that only knows an
 * attachment id can still re-read the original image.
 * @module @dsh-external/dsh-vision-plugin/attachment-reader
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/

/** Magic-byte sniffs for the accepted raster formats. */
const SNIFFS: readonly { mediaType: ImageMediaType; test: (buffer: Buffer) => boolean }[] = [
  { mediaType: 'image/png', test: buffer => buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { mediaType: 'image/jpeg', test: buffer => buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff },
  { mediaType: 'image/webp', test: buffer => buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP' },
  { mediaType: 'image/gif', test: buffer => buffer.length >= 6 && buffer.subarray(0, 6).toString('latin1') === 'GIF89a' },
]

/** Resolve the harness home: `$DSH_HOME` when set, else `~/.dsh`. */
export function defaultHarnessHome(): string {
  const fromEnv = process.env.DSH_HOME
  return resolve(fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'))
}

/** One read attachment: the bytes and the recovered media type. */
export interface ReadAttachment {
  data: Uint8Array
  mediaType: ImageMediaType
}

/**
 * Read one durable image by content address.
 * @param attachmentId - the durable `sha256:<hex>` address from the session log.
 * @param home - the harness home to read from (defaults to `$DSH_HOME`/`~/.dsh`).
 * @returns the verified bytes and the recovered media type.
 * @throws when the id is malformed or no object exists at the address.
 */
export async function readAttachmentById(
  attachmentId: string,
  home = defaultHarnessHome(),
): Promise<ReadAttachment> {
  const match = ID_PATTERN.exec(attachmentId)
  if (match?.[1] === undefined) {
    throw new Error(`invalid attachment id "${attachmentId}": expected sha256:<64 hex digits>`)
  }
  const sha256 = match[1]
  const objectPath = join(home, 'attachments', 'v1', 'objects', sha256.slice(0, 2), sha256)
  let data: Uint8Array
  try {
    data = new Uint8Array(await readFile(objectPath))
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`attachment ${attachmentId} is not stored (${objectPath} missing)`)
    }
    throw error
  }
  const buffer = Buffer.from(data)
  const sniff = SNIFFS.find(candidate => candidate.test(buffer))
  if (sniff === undefined) {
    throw new Error(`attachment ${attachmentId} is not a recognized image (png/jpeg/webp/gif)`)
  }
  return { data, mediaType: sniff.mediaType }
}
