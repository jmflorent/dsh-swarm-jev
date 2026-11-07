/**
 * Image transport for System One requests.
 *
 * The TypeSafe `systemOne` contract does not accept base64 inside `state`. An
 * image travels as a `multipart/form-data` body: the first part, named
 * `request`, is the JSON payload; every asset is a later part named `asset-N`
 * and referenced from the payload's `assets` map as
 * `{ [alias]: { type: 'image', part: 'asset-N' } }`.
 *
 * This module builds exactly that body so the plugin can stay dependency-free.
 *
 * @module systemone/vision
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { randomBytes } from 'node:crypto'

/** PNG/JPEG magic numbers; the endpoint rejects anything else. */
const PNG = [0x89, 0x50, 0x4e, 0x47]
const JPEG = [0xff, 0xd8, 0xff]

const mediaTypeOf = (bytes) => {
  if (PNG.every((byte, index) => bytes[index] === byte)) return 'image/png'
  if (JPEG.every((byte, index) => bytes[index] === byte)) return 'image/jpeg'
  return undefined
}

/** Aliases are referenced literally inside state text, so keep them token-like. */
const aliasOf = (name, index) => {
  const raw = typeof name === 'string' && name.trim().length > 0 ? name.trim() : `image-${index}`
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, '-')
  return clean.length === 0 ? `image-${index}` : clean
}

/**
 * Read and validate one image reference.
 *
 * @param {{ path?: string, name?: string }} input caller-declared image.
 * @param {number} index position, used for the default alias.
 * @param {number} maxBytes per-image ceiling.
 * @returns {Promise<{ alias: string, bytes: Uint8Array, mediaType: string, bytesLength: number }>}
 */
export const loadImage = async (input, index, maxBytes) => {
  if (input === null || typeof input !== 'object' || typeof input.path !== 'string' || input.path.trim() === '') {
    throw new Error('each image needs an object like { "path": "/abs/path/photo.png", "name": "photo" }')
  }
  const bytes = new Uint8Array(await readFile(input.path))
  if (bytes.byteLength === 0) throw new Error(`image "${input.path}" is empty`)
  if (bytes.byteLength > maxBytes) {
    throw new Error(`image "${input.path}" is ${bytes.byteLength} bytes; the configured maximum is ${maxBytes}`)
  }
  const mediaType = mediaTypeOf(bytes)
  if (mediaType === undefined) {
    throw new Error(`image "${input.path}" is not PNG or JPEG (detected from its first bytes)`)
  }
  return {
    alias: aliasOf(input.name ?? basename(input.path).replace(/\.[^.]+$/, ''), index),
    bytes,
    mediaType,
    bytesLength: bytes.byteLength,
  }
}

/**
 * Build the multipart body for one request carrying images.
 *
 * The returned JSON payload is a copy with an `assets` map added; the caller's
 * object is not mutated.
 *
 * @param {object} payload request payload without `assets`.
 * @param {readonly { alias: string, bytes: Uint8Array, mediaType: string }[]} images loaded images.
 * @returns {{ body: Uint8Array, contentType: string, assets: Record<string, { type: 'image', part: string }> }}
 */
export const buildMultipart = (payload, images) => {
  const boundary = `----dsh-systemone-${randomBytes(12).toString('hex')}`
  const parts = []
  const assets = {}

  const requestPart =
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="request"\r\n' +
    'Content-Type: application/json\r\n\r\n' +
    `${JSON.stringify({ ...payload, assets })}\r\n`
  parts.push(Buffer.from(requestPart, 'utf8'))

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index]
    const part = `asset-${index}`
    assets[image.alias] = { type: 'image', part }
    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="${part}"; filename="${part}"\r\n` +
          `Content-Type: ${image.mediaType}\r\n\r\n`,
        'utf8',
      ),
    )
    parts.push(Buffer.from(image.bytes))
    parts.push(Buffer.from('\r\n', 'utf8'))
  }

  // The request part must carry the final assets map, so rebuild it once the
  // part names are known. Keeping the build linear costs one extra stringify.
  parts[0] = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="request"\r\n' +
      'Content-Type: application/json\r\n\r\n' +
      `${JSON.stringify({ ...payload, assets })}\r\n`,
    'utf8',
  )

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'))
  return {
    body: new Uint8Array(Buffer.concat(parts)),
    contentType: `multipart/form-data; boundary=${boundary}`,
    assets,
  }
}
