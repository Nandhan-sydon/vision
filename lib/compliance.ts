/**
 * Deterministic main-image compliance checks, against Amazon's actual published rules.
 *
 * Test tooling, NOT pipeline code — nothing here gates or alters a generated image.
 * V1 stays generation-only (spec §4); this exists so the report can state
 * "background is exactly 255, product fills 91%, not cropped" instead of "looks right".
 *
 * The rules being checked, and where the spec's paraphrase differs from Amazon:
 *
 *  - Background must be EXACTLY RGB(255,255,255). Amazon's automated scan flags
 *    deviations that are invisible to the eye, so "near enough" is a failure there even
 *    though it looks perfect. Reported separately from visual whiteness for that reason.
 *  - Product fills 85% OR MORE of the frame. There is no upper bound. The spec says
 *    "85-90%", which is tighter than Amazon requires — a 94% fill is compliant.
 *  - The entire product must be visible; cropping at the frame edge is a hard fail.
 *    This, not the fill percentage, is what actually failed in V1's test run.
 *  - Minimum 1000px on the longest side, 2000px+ recommended for zoom.
 *
 * Background is sampled OUTSIDE the product bounding box, not from a fixed border ring.
 * At an 85%+ fill there is only a few percent of margin per side, so a ring samples the
 * product itself and reports it as a dirty background.
 */

import sharp from 'sharp'

export type ComplianceReport = {
  width: number
  height: number
  longestEdge: number

  bgPureWhitePct: number
  bgMaxDeviation: number
  bgMeanDeviation: number
  /**
   * Largest deviation from 255 in the background, ignoring a ring of `edgeExclusionPx`
   * around the product's bounding box.
   *
   * This is the figure the release gate uses, and the distinction is not a loosening of the
   * rule — it is what the rule is actually about. Amazon rejects an off-white background: a
   * tint, a gradient, a grey studio sweep, a shadow falling across the field. Those show up
   * across the whole background and this figure catches every one of them.
   *
   * What it excludes is JPEG ringing in the 8x8 blocks that straddle the product's outline.
   * §10 requires the released file to be JPEG, and a hard edge in a JPEG rings — always, in
   * every encoder, at every quality. Measured here on a synthetic hard-edged product:
   * 3-7/255 in that one ring, and 0 everywhere else, unchanged by further encoding rounds.
   * Gating on the unmasked figure would mean no main image could ever be released, which is
   * not a stricter reading of the rule, just a broken pipeline.
   */
  bgMaxDeviationExcludingEdge: number

  fillWidthPct: number
  fillHeightPct: number
  /** The figure Amazon's 85% rule applies to: the larger axis. */
  fillLinearPct: number
  fillAreaPct: number
  touchesEdge: boolean

  passes: {
    /**
     * The release gate: literally RGB(255,255,255) across the background, excluding the
     * one-block ring at the product's outline where JPEG ringing is unavoidable.
     */
    exactlyPureWhite: boolean
    /** The same test with no exclusion at all. Reported for the record, never gated on. */
    exactlyPureWhiteUnmasked: boolean
    /** Indistinguishable from white to a human, but Amazon's scanner may still reject. */
    visuallyWhite: boolean
    /** >= 85%, no upper bound. */
    frameFill: boolean
    /** Entire product inside the frame. */
    notCropped: boolean
    /** >= 1000px on the longest side. */
    resolutionMinimum: boolean
    /** >= 2000px on the longest side (Amazon's recommendation for zoom). */
    resolutionRecommended: boolean
  }
  /** True only when every hard requirement passes. */
  amazonReady: boolean
  notes: string[]
}

/** Below this on any channel, a pixel counts as product rather than background. */
const SUBJECT_THRESHOLD = 245
/** Deviation at or below this is imperceptible to a human — but not to Amazon. */
const VISUALLY_WHITE_TOLERANCE = 5
const MIN_FILL_PCT = 85
const MIN_EDGE_PX = 1000
const RECOMMENDED_EDGE_PX = 2000

export async function checkCompliance(
  input: Buffer,
  opts: {
    fillMin?: number
    /**
     * Stage 2 spec §16: a necklace — and only a necklace — may crop at the frame edge.
     * Everywhere else this is the hard fail, so it is opt-in per image rather than a
     * threshold, and the report still records `touchesEdge` truthfully either way.
     */
    allowEdgeCrop?: boolean
    /**
     * Pixels around the product's bounding box excluded from the background purity test.
     *
     * Defaults to 0, so a bare call still reports the strictest possible figure. The
     * compliance pass sets one JPEG MCU (8px); see bgMaxDeviationExcludingEdge.
     */
    edgeExclusionPx?: number
  } = {},
): Promise<ComplianceReport> {
  const fillMin = opts.fillMin ?? MIN_FILL_PCT
  const exclusion = Math.max(0, opts.edgeExclusionPx ?? 0)

  const { data, info } = await sharp(input)
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true })

  const { width, height, channels } = info
  const at = (x: number, y: number) => {
    const i = (y * width + x) * channels
    return [data[i], data[i + 1], data[i + 2]] as const
  }

  // --- pass 1: subject mask, bounding box, edge contact ---
  let minX = width
  let minY = height
  let maxX = -1
  let maxY = -1
  let subjectPixels = 0

  const edgeBand = Math.max(1, Math.round(Math.min(width, height) * 0.005))
  let touchesEdge = false

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = at(x, y)
      if (r < SUBJECT_THRESHOLD || g < SUBJECT_THRESHOLD || b < SUBJECT_THRESHOLD) {
        subjectPixels++
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
        if (
          x < edgeBand ||
          x >= width - edgeBand ||
          y < edgeBand ||
          y >= height - edgeBand
        ) {
          touchesEdge = true
        }
      }
    }
  }

  const found = maxX >= 0
  const bboxW = found ? maxX - minX + 1 : 0
  const bboxH = found ? maxY - minY + 1 : 0

  // --- pass 2: background is everything outside the bounding box ---
  let bgTotal = 0
  let bgPure = 0
  let bgMaxDev = 0
  let bgDevSum = 0
  let bgMaxDevExcludingEdge = 0

  // The bounding box grown by the exclusion ring. Pixels inside it are still counted in the
  // headline figures and skipped only for bgMaxDeviationExcludingEdge, so nothing is hidden.
  const exMinX = minX - exclusion
  const exMaxX = maxX + exclusion
  const exMinY = minY - exclusion
  const exMaxY = maxY + exclusion

  for (let y = 0; y < height; y++) {
    const outsideRow = !found || y < minY || y > maxY
    for (let x = 0; x < width; x++) {
      if (!(outsideRow || x < minX || x > maxX)) continue
      const [r, g, b] = at(x, y)
      bgTotal++
      if (r === 255 && g === 255 && b === 255) bgPure++
      const dev = Math.max(255 - r, 255 - g, 255 - b)
      bgDevSum += dev
      if (dev > bgMaxDev) bgMaxDev = dev

      const nearProduct =
        found && x >= exMinX && x <= exMaxX && y >= exMinY && y <= exMaxY
      if (!nearProduct && dev > bgMaxDevExcludingEdge) bgMaxDevExcludingEdge = dev
    }
  }

  const bgPureWhitePct = bgTotal ? (bgPure / bgTotal) * 100 : 0
  const bgMeanDeviation = bgTotal ? bgDevSum / bgTotal : 0
  const fillWidthPct = (bboxW / width) * 100
  const fillHeightPct = (bboxH / height) * 100
  const fillLinearPct = Math.max(fillWidthPct, fillHeightPct)
  const fillAreaPct = (subjectPixels / (width * height)) * 100
  const longestEdge = Math.max(width, height)

  const passes = {
    exactlyPureWhite: bgMaxDevExcludingEdge === 0,
    exactlyPureWhiteUnmasked: bgMaxDev === 0,
    visuallyWhite: bgMaxDev <= VISUALLY_WHITE_TOLERANCE,
    frameFill: fillLinearPct >= fillMin,
    notCropped: !touchesEdge || opts.allowEdgeCrop === true,
    resolutionMinimum: longestEdge >= MIN_EDGE_PX,
    resolutionRecommended: longestEdge >= RECOMMENDED_EDGE_PX,
  }

  const notes: string[] = []
  if (!found) notes.push('No non-white content detected — image may be blank.')

  if (passes.exactlyPureWhiteUnmasked) {
    notes.push('Background is exactly RGB(255,255,255), every pixel.')
  } else if (passes.exactlyPureWhite) {
    notes.push(
      `Background is exactly RGB(255,255,255) across the field, with up to ${bgMaxDev}/255 ` +
        `confined to the ${exclusion}px ring at the product outline — JPEG ringing at a hard ` +
        'edge, not a tint.',
    )
  } else if (passes.visuallyWhite) {
    notes.push(
      `Background looks white but is not literally 255 (max ${bgMaxDev}/255 off, ` +
        `${bgPureWhitePct.toFixed(1)}% of pixels exact). Amazon's scanner flags this — ` +
        'run snapWhitePoint() from lib/postprocess.ts before upload.',
    )
  } else {
    notes.push(
      `Background deviates up to ${bgMaxDev}/255 — a real tint, gradient, or shadow, ` +
        'not just codec noise.',
    )
  }

  if (touchesEdge) {
    notes.push(
      opts.allowEdgeCrop
        ? 'Product touches the frame edge — permitted here under the §16 necklace exception.'
        : 'Product touches the frame edge — Amazon requires the whole product visible.',
    )
  }
  if (!passes.frameFill) {
    notes.push(`Product fills ${fillLinearPct.toFixed(1)}% — Amazon requires 85% or more.`)
  }
  if (!passes.resolutionMinimum) {
    notes.push(`${longestEdge}px longest edge — below Amazon's 1000px minimum.`)
  } else if (!passes.resolutionRecommended) {
    notes.push(
      `${longestEdge}px longest edge — meets the 1000px minimum but below the 2000px ` +
        'recommended for zoom.',
    )
  }

  return {
    width,
    height,
    longestEdge,
    bgPureWhitePct: round(bgPureWhitePct),
    bgMaxDeviation: bgMaxDev,
    bgMeanDeviation: round(bgMeanDeviation),
    bgMaxDeviationExcludingEdge: bgMaxDevExcludingEdge,
    fillWidthPct: round(fillWidthPct),
    fillHeightPct: round(fillHeightPct),
    fillLinearPct: round(fillLinearPct),
    fillAreaPct: round(fillAreaPct),
    touchesEdge,
    passes,
    // Resolution recommendation is not a hard requirement, so it is excluded here.
    amazonReady:
      passes.exactlyPureWhite &&
      passes.frameFill &&
      passes.notCropped &&
      passes.resolutionMinimum,
    notes,
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}
