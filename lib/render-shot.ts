/**
 * The render loop for one shot — Stage 2 spec §11 into §12.
 *
 *   route photos ─▶ write prompt ─▶ generate ─▶ REVIEW ─▶ pass ─▶ COMPLIANCE PASS ─▶ output
 *                        ▲                        │                      │
 *                        └─── the reviewer's ─────┘                      │
 *                             actual defects  ◀───── not released ───────┘
 *
 * ## Why review comes before the compliance pass
 *
 * This is the order §11 and §12 specify, and it reverses what an earlier build did. The
 * argument for correcting first was real: a reviewer shown an uncorrected image reports
 * "the background is not pure white" on every attempt, because no generator outputs
 * mathematically flat white, and the whole retry budget goes on a fault no retry can fix.
 *
 * That is solved in the review prompt rather than by reordering. The reviewer is told
 * explicitly which properties the downstream pass corrects — exact white point, fill
 * percentage, centring, resolution, format — and told not to judge them. What it does judge
 * about a main image's background is its CONTENT: a coloured or textured backdrop, a surface
 * under the product, a cast shadow, a border. Those no pass can fix and every retry can.
 *
 * So the spec's order holds and the retry budget still goes on real faults.
 *
 * ## Three further properties, each deliberate
 *
 * **The retry carries defects, not a flag.** Regenerating the same prompt is a lottery at
 * $0.13 a ticket. The rewritten prompt names the wording that was wrong, the grip that was
 * impossible, the viewpoint that came back unchanged.
 *
 * **A compliance-pass failure is a failed attempt, not a shipped image.** §18 forbids
 * silently substituting a partially-compliant result, so if the pass cannot release the
 * file, its own notes go back to the prompt writer as defects and the shot retries.
 *
 * **A failed shot returns its best attempt, flagged.** §11 requires exactly this after the
 * retry cap: the best attempt proceeds carrying "needs review" rather than looping forever.
 * The caller gets the image, the verdict, and a sentence for the seller, and decides.
 */

import { writePrompt, type HintHandling } from './claude/prompt'
import type { ImageDNA } from './claude/dna'
import { defectLines, reviewImage, scoreReview, type Review } from './claude/review'
import { compliancePass, type CompliancePassResult } from './compliance-pass'
import { allowsEdgeCrop } from './amazon/rules'
import { selectPhotos, type Base64Image } from './photos'
import { usablePhotoIndexes } from './claude/dna'
import { describeStyle, type ResolvedStyle } from './style-grid'
import { withEntry, type BuildEntry, type BuildMemory } from './build-memory'
import type { ImageGenerator } from './generators/types'
import type { Slot } from './slots'
import { claudeCostUsd, type ClaudeUsage } from './cost'

export type Attempt = {
  /** 1-based. */
  n: number
  prompt: string
  hintHandling: HintHandling
  /** Photo indexes handed to the generator for this attempt. */
  referenceIndexes: number[]
  /** The style grid values this attempt was generated under. */
  style: ResolvedStyle
  /** The released bytes when the compliance pass ran; the raw generation otherwise. */
  imageBase64: string
  mimeType: string
  /** Absent when review is switched off. */
  review?: Review
  /** Absent when the attempt never reached §12 because review rejected it. */
  compliance?: {
    released: boolean
    width: number
    height: number
    bytes: number
    actions: string[]
    notes: string[]
    fillLinearPct?: number
    bgMaxDeviation?: number
    touchesEdge?: boolean
    amazonReady?: boolean
  }
  costUsd: number
  ms: number
  retries: number
}

export type RenderOutcome = {
  slotId: string
  slotLabel: string
  /** The attempt being shipped: the first fully clean one, or the best-scoring otherwise. */
  best: Attempt
  attempts: Attempt[]
  /**
   * True only when an attempt cleared review AND the compliance pass released it.
   *
   * False is §11's "needs review" flag. It is the signal that an image is being handed over
   * without having passed, and §18 forbids presenting that quietly as a success.
   */
  passed: boolean
  /**
   * 'passed'        cleared review and was released by the compliance pass.
   * 'not-reviewed'  review was switched off. One attempt, unchecked.
   * 'exhausted'     every attempt failed review or release. Best is shipped flagged.
   * 'unfixable'     no prompt reaches the fault — normally a surface no photograph shows.
   */
  stoppedBecause: 'passed' | 'not-reviewed' | 'exhausted' | 'unfixable'
  /** Plain sentence for the seller when the shot could not be produced honestly. */
  sellerNote: string
  /** Build memory including this shot, for the caller to persist and pass forward. */
  buildMemory: BuildMemory
  costUsd: number
  ms: number
}

export type RenderOptions = {
  generator: ImageGenerator
  dna: ImageDNA
  slot: Slot
  /** Every photo the seller uploaded, in upload order. Routing selects from these. */
  photos: Base64Image[]
  hint?: string
  /** What has already been generated for this product (§7, third input). */
  buildMemory: BuildMemory
  /** §11. Three total attempts per shot, then the best proceeds flagged. */
  maxAttempts?: number
  /** Set false for one generation with no review and no retry. */
  review?: boolean
  /** Progress for long runs; each attempt takes 40-140s. */
  onProgress?: (event: {
    stage: 'prompt' | 'generate' | 'review' | 'compliance'
    attempt: number
    detail?: string
  }) => void
}

/** §11. Retry cap: 3 total attempts per shot. */
export const DEFAULT_MAX_ATTEMPTS = 3

export async function renderShot(opts: RenderOptions): Promise<RenderOutcome> {
  const started = Date.now()
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)
  const reviewEnabled = opts.review ?? true
  const progress = opts.onProgress ?? (() => {})
  const isMain = opts.slot.mode === 'locked'

  const attempts: Attempt[] = []
  let costUsd = 0
  let feedback:
    | { previousPrompt: string; defects: string[]; fixInstructions: string; attempt: number }
    | undefined
  let routing = opts.slot.sourcePhotos
  let stoppedBecause: RenderOutcome['stoppedBecause'] = 'exhausted'
  let sellerNote = ''

  for (let n = 1; n <= maxAttempts; n++) {
    const attemptStarted = Date.now()
    let attemptCost = 0

    // --- route ---
    const { photos: references, usedIndexes } = selectPhotos(opts.photos, routing)

    // --- write: Image DNA + style grid + build memory + marketplace rules (§8) ---
    progress({ stage: 'prompt', attempt: n })
    const written = await writePrompt({
      dna: opts.dna,
      slot: opts.slot,
      hint: opts.hint,
      referenceIndexes: usedIndexes,
      buildMemory: opts.buildMemory,
      feedback,
    })
    attemptCost += claudeCostUsd(written.usage)

    // --- generate ---
    progress({ stage: 'generate', attempt: n, detail: opts.generator.label })
    const generated = await opts.generator.generate(
      written.result.prompt,
      references,
      opts.slot.renderMode ?? 'edit',
    )
    attemptCost += generated.costUsd

    const attempt: Attempt = {
      n,
      prompt: written.result.prompt,
      hintHandling: written.result.hintHandling,
      referenceIndexes: usedIndexes,
      style: written.style,
      imageBase64: generated.imageBase64,
      mimeType: generated.mimeType,
      costUsd: attemptCost,
      ms: Date.now() - attemptStarted,
      retries: generated.retries,
    }

    // --- §11 review, on the raw generation ---
    let review: Review | undefined
    if (reviewEnabled) {
      progress({ stage: 'review', attempt: n })
      const reviewed = await reviewImage({
        dna: opts.dna,
        slot: opts.slot,
        prompt: written.result.prompt,
        references,
        candidate: { data: generated.imageBase64, mediaType: generated.mimeType },
        attempt: n,
        attemptsLeft: maxAttempts - n,
      })
      review = reviewed.review
      attempt.review = review
      attemptCost += claudeCostUsd(reviewed.usage)
    }

    // A rejected image never reaches §12: the compliance pass exists to prepare an image for
    // publication, and running it on a discard buys nothing but latency.
    if (review && review.verdict !== 'pass') {
      attempt.costUsd = attemptCost
      attempt.ms = Date.now() - attemptStarted
      attempts.push(attempt)
      costUsd += attemptCost

      if (review.verdict === 'reject') {
        // No prompt reaches this fault. Retrying arrives at the same answer two generations
        // and ~$0.30 later, so stop and hand the seller the photograph they need to take.
        stoppedBecause = 'unfixable'
        sellerNote = review.sellerNote
        break
      }
      sellerNote = review.sellerNote || sellerNote

      if (n < maxAttempts) {
        feedback = {
          previousPrompt: written.result.prompt,
          defects: defectLines(review),
          fixInstructions: review.fixInstructions,
          attempt: n,
        }
        // 'reroute-photos' says the references were the problem, not the wording. Widening
        // to every usable photo is the only correction available here: the reviewer can see
        // the supplied references are wrong for the shot, but it was never shown the photos
        // that were withheld, so it cannot name a better subset.
        if (review.retryStrategy === 'reroute-photos') {
          routing = usablePhotoIndexes(opts.dna)
        }
      }
      continue
    }

    // --- §12 compliance pass: deterministic, on every image that will be published ---
    progress({ stage: 'compliance', attempt: n })
    const released: CompliancePassResult = await compliancePass(
      Buffer.from(generated.imageBase64, 'base64'),
      {
        isMain,
        allowEdgeCrop: allowsEdgeCrop({
          category: opts.dna.amazonCategory,
          product: opts.dna.product,
        }),
      },
    )

    attempt.imageBase64 = released.buffer.toString('base64')
    attempt.mimeType = released.mimeType
    attempt.compliance = {
      released: released.released,
      width: released.width,
      height: released.height,
      bytes: released.bytes,
      actions: released.actions,
      notes: released.notes,
      fillLinearPct: released.report?.fillLinearPct,
      bgMaxDeviation: released.report?.bgMaxDeviation,
      touchesEdge: released.report?.touchesEdge,
      amazonReady: released.report?.amazonReady,
    }
    attempt.costUsd = attemptCost
    attempt.ms = Date.now() - attemptStarted
    attempts.push(attempt)
    costUsd += attemptCost

    if (released.released) {
      stoppedBecause = reviewEnabled ? 'passed' : 'not-reviewed'
      break
    }

    // §18: never quietly ship a partially-compliant result. The pass could not release this
    // file, so this is a failed attempt like any other — and its notes are the most precise
    // feedback available anywhere in the loop, because they are measurements not impressions.
    sellerNote =
      sellerNote ||
      'This shot could not be brought within the marketplace image rules automatically.'
    if (n < maxAttempts) {
      feedback = {
        previousPrompt: written.result.prompt,
        defects: released.notes.map((note) => `[blocker/compliance] ${note}`),
        fixInstructions:
          'The deterministic correction pass could not bring the generated image within the ' +
          'marketplace rules. ' +
          released.notes.join(' ') +
          ' Rewrite the prompt so the generator produces an image the pass can correct: the ' +
          'product complete and unobstructed, well inside the frame, alone on a plain white ' +
          'field with no surface, shadow, border, or second object.',
        attempt: n,
      }
    }
  }

  const best = pickBest(attempts)
  const cleared = stoppedBecause === 'passed' || stoppedBecause === 'not-reviewed'

  // Build memory records what SHIPPED, passing or flagged. A flagged shot is still on the
  // listing and still sets the look the next shot has to match, so omitting it would have
  // shot four matching shot three's intended appearance rather than its actual one.
  const buildMemory = withEntry(opts.buildMemory, {
    shotId: opts.slot.id,
    shotLabel: opts.slot.label,
    kind: opts.slot.kind ?? 'angle',
    lightingId: best.style.lighting.id,
    sceneId: best.style.scene?.id,
    shadow: best.style.shadow,
    passed: cleared,
    promptExcerpt: best.prompt,
    at: new Date().toISOString(),
  } satisfies BuildEntry)

  return {
    slotId: opts.slot.id,
    slotLabel: opts.slot.label,
    best,
    attempts,
    passed: cleared,
    stoppedBecause,
    sellerNote,
    buildMemory,
    costUsd,
    ms: Date.now() - started,
  }
}

/**
 * The attempt to ship.
 *
 * An attempt that cleared review AND was released always wins, and it is always the last one
 * because the loop stops there. Only when nothing cleared does ranking matter, and then the
 * highest-scoring attempt wins rather than the most recent. Attempts do not monotonically
 * improve: a rewrite that fixes a re-lettered logo can introduce a warped handle, and
 * shipping the latest on the assumption that later is better trades a known-fixed defect for
 * a fresh one.
 */
function pickBest(attempts: Attempt[]): Attempt {
  if (attempts.length === 0) {
    throw new Error('renderShot produced no attempts — the loop exited without generating.')
  }
  const clean = attempts.find(
    (a) => a.review?.verdict === 'pass' && a.compliance?.released !== false,
  )
  if (clean) return clean
  if (!attempts.some((a) => a.review)) return attempts[attempts.length - 1]

  return attempts.reduce((best, a) => {
    const score = a.review ? scoreReview(a.review) : -Infinity
    const bestScore = best.review ? scoreReview(best.review) : -Infinity
    return score > bestScore ? a : best
  })
}

/** One line per attempt, for scripts and the run report. */
export function renderOutcomeLines(outcome: RenderOutcome): string[] {
  const lines: string[] = []
  for (const a of outcome.attempts) {
    const r = a.review
    const verdict = r ? r.verdict.toUpperCase() : 'NO REVIEW'
    const scores = r
      ? ` identity ${r.scores.identity} brief ${r.scores.brief} realism ${r.scores.realism}`
      : ''
    lines.push(
      `  attempt ${a.n}: ${verdict}${scores} · ${describeStyle(a.style)} · ` +
        `$${a.costUsd.toFixed(3)} · ${(a.ms / 1000).toFixed(0)}s`,
    )
    for (const d of r?.defects ?? []) {
      lines.push(`      [${d.severity}] ${d.kind}: ${d.description}`)
    }
    if (a.compliance) {
      lines.push(
        `      §12 ${a.compliance.released ? 'RELEASED' : 'NOT RELEASED'} · ` +
          `${a.compliance.width}×${a.compliance.height} · ` +
          `${(a.compliance.bytes / 1024).toFixed(0)}KB` +
          (a.compliance.fillLinearPct != null
            ? ` · fill ${a.compliance.fillLinearPct}% · bg dev ${a.compliance.bgMaxDeviation}`
            : ''),
      )
      for (const note of a.compliance.notes) lines.push(`      note: ${note}`)
    }
  }
  lines.push(
    `  → shipping attempt ${outcome.best.n} (${outcome.stoppedBecause})` +
      `${outcome.passed ? '' : ' [NEEDS REVIEW]'}, $${outcome.costUsd.toFixed(3)} total`,
  )
  if (outcome.sellerNote) lines.push(`  → seller: ${outcome.sellerNote}`)
  return lines
}

export type { ClaudeUsage }
