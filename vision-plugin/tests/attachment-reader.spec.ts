/**
 * Attachment-by-id reader: resolves the content-addressed store layout,
 * validates the id, recovers the media type from the bytes, and fails
 * cleanly on malformed or missing objects.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultHarnessHome, readAttachmentById } from '../src/attachment-reader.ts'

/** 1x1 PNG (valid signature, IHDR, IDAT). */
const PNG = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
))

const homes: string[] = []
afterEach(async () => {
  await Promise.all(homes.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function seedAttachment(): Promise<{ home: string; attachmentId: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-vision-store-'))
  homes.push(home)
  const sha256 = createHash('sha256').update(PNG).digest('hex')
  const dir = join(home, 'attachments', 'v1', 'objects', sha256.slice(0, 2))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, sha256), PNG)
  return { home, attachmentId: `sha256:${sha256}` }
}

describe('readAttachmentById', () => {
  it('reads a stored attachment and recovers the media type from the bytes', async () => {
    const { home, attachmentId } = await seedAttachment()
    const stored = await readAttachmentById(attachmentId, home)
    expect(stored.mediaType).toBe('image/png')
    expect([...stored.data]).toEqual([...PNG])
  })

  it('rejects malformed ids', async () => {
    const { home } = await seedAttachment()
    await expect(readAttachmentById('not-an-id', home)).rejects.toThrow(/invalid attachment id/)
    await expect(readAttachmentById('sha256:short', home)).rejects.toThrow(/invalid attachment id/)
  })

  it('fails cleanly when the object is missing', async () => {
    const { home } = await seedAttachment()
    await expect(readAttachmentById(`sha256:${'0'.repeat(64)}`, home)).rejects.toThrow(/is not stored/)
  })

  it('fails when the object is not a recognized image', async () => {
    const { home } = await seedAttachment()
    const sha256 = createHash('sha256').update(Buffer.from('plain text')).digest('hex')
    const dir = join(home, 'attachments', 'v1', 'objects', sha256.slice(0, 2))
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, sha256), 'plain text')
    await expect(readAttachmentById(`sha256:${sha256}`, home)).rejects.toThrow(/not a recognized image/)
  })

  it('defaults the home to $DSH_HOME or ~/.dsh', () => {
    const previous = process.env.DSH_HOME
    try {
      delete process.env.DSH_HOME
      expect(defaultHarnessHome()).toMatch(/\.dsh$/)
      process.env.DSH_HOME = 'C:\\custom\\home'
      expect(defaultHarnessHome()).toBe('C:\\custom\\home')
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
