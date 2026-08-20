import Anthropic from '@anthropic-ai/sdk'
import { getKeys } from '../config'
import { ALLOWED_MEDIA, photoLabel, type Base64Image } from '../photos'

let cached: Anthropic | null = null

export function claude(): Anthropic {
  if (!cached) cached = new Anthropic({ apiKey: getKeys().anthropic })
  return cached
}

/** Pull the first text block out of a response, or explain why there isn't one. */
export function firstText(response: Anthropic.Message): string {
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      'Claude response hit max_tokens. On Opus 5 thinking shares the max_tokens budget ' +
        'with the response — raise CLAUDE_MAX_TOKENS in lib/config.ts.',
    )
  }
  if (response.stop_reason === 'refusal') {
    throw new Error(
      `Claude declined this request (${response.stop_details?.category ?? 'unspecified'}).`,
    )
  }
  const block = response.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text') {
    throw new Error(
      `No text block in Claude response (stop_reason: ${response.stop_reason}).`,
    )
  }
  return block.text
}

/** Structured outputs guarantee schema-valid JSON, but parse defensively anyway. */
export function parseJson<T>(text: string, context: string): T {
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(
      `${context}: expected JSON but got ${text.slice(0, 200)}${text.length > 200 ? '…' : ''}`,
    )
  }
}

export type { Base64Image }

export function imageBlock(image: Base64Image): Anthropic.ImageBlockParam {
  if (!ALLOWED_MEDIA.includes(image.mediaType as (typeof ALLOWED_MEDIA)[number])) {
    throw new Error(
      `Unsupported image type "${image.mediaType}". Use one of: ${ALLOWED_MEDIA.join(', ')}`,
    )
  }
  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mediaType as (typeof ALLOWED_MEDIA)[number],
      data: image.data,
    },
  }
}

/**
 * Several images in one message, each preceded by a text block naming it.
 *
 * The label is not decoration. Once a request carries five photos, every answer about
 * them ("the grip appears in photos 2 and 4") is useless unless the model and the code
 * agree on which image is which, and Claude cannot infer an ordinal from an unlabelled
 * image block. Labelling is what makes the photo→surface map trustworthy, and that map
 * is what stops a shot being rendered from a surface no photo shows.
 *
 * `caption` lets a caller distinguish roles as well as ordinals — the reviewer sends
 * source photos and a generated candidate in the same message and must not confuse them.
 */
export function labelledImageBlocks(
  images: Base64Image[],
  caption: (index: number) => string = (i) => photoLabel(i),
): Anthropic.ContentBlockParam[] {
  return images.flatMap((image, i) => [
    { type: 'text' as const, text: `--- ${caption(i)} ---` },
    imageBlock(image),
  ])
}
