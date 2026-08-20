/**
 * White-point snap for main images.
 *
 * Amazon requires the main-image background to be exactly RGB(255,255,255) and their
 * automated scan rejects deviations that are invisible to the eye. Every image V1
 * measured came back at 4-8/255 off pure white — visually perfect, and non-compliant.
 * No prompt fixes this: the models simply do not output a mathematically flat white.
 *
 * So it is fixed deterministically after generation rather than asked for.
 *
 * This is post-processing, not generation, and it deliberately does NOT touch the
 * product: only pixels at or above `threshold` on every channel are snapped, so a
 * genuinely white product surface a few shades below 255 is left alone. The trade-off is
 * that a product containing pure-white pixels adjacent to the background will have those
 * snapped too — harmless, since they were already white.
 */

import sharp from 'sharp'

export type SnapResult = {
  buffer: Buffer
  /** Share of pixels that were adjusted. */
  changedPct: number
  /** Largest correction applied on any channel. */
  maxCorrection: number
}

/**
 * Anything at or above this on all three channels is treated as background and forced to
 * pure white. 246 sits just above the 245 subject threshold used by the compliance
 * checker, so the two agree on what counts as product.
 */
const DEFAULT_THRESHOLD = 246

export async function snapWhitePoint(
  input: Buffer,
  opts: { threshold?: number } = {},
): Promise<SnapResult> {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD

  const { data, info } = await sharp(input)
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height, channels } = info
  let changed = 0
  let maxCorrection = 0

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    if (r >= threshold && g >= threshold && b >= threshold) {
      const correction = Math.max(255 - r, 255 - g, 255 - b)
      if (correction > 0) {
        changed++
        if (correction > maxCorrection) maxCorrection = correction
        data[i] = 255
        data[i + 1] = 255
        data[i + 2] = 255
      }
    }
  }

  const buffer = await sharp(data, { raw: { width, height, channels } })
    .png()
    .toBuffer()

  return {
    buffer,
    changedPct: Math.round((changed / (width * height)) * 1000) / 10,
    maxCorrection,
  }
}
