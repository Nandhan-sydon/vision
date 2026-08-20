/**
 * Stage 4 — the reviewer.
 *
 * Looks at a generated image next to the real photographs it was supposed to reproduce,
 * and answers one question: would shipping this misrepresent the product? If not, it says
 * what is wrong in terms the prompt writer can act on, and the render loop tries again.
 *
 * ## Why a model reviews at all, given the compliance pass is deterministic
 *
 * V1 concluded that a review loop was not worth building, because the failures it measured
 * — frame fill, off-white background, a product cropped at the edge — are all geometric
 * and are fixed correctly and for free by `lib/postprocess.ts` and `lib/compliance.ts`. No
 * model should be asked to eyeball a fill percentage, and this one is not: those numbers
 * are computed and handed to it.
 *
 * What changed is the shot list. V1 rendered crops and background swaps, where identity
 * held to 2%. The set now includes a person gripping the product, a macro on a marking,
 * and viewpoints drawn from different photographs — and those fail in ways no measurement
 * catches. A six-fingered hand, a logo re-lettered from LARSEN to LARSON, a bat fused to a
 * forearm, a grip macro that quietly invented a wear pattern: each is a perfect image by
 * every deterministic check, and each misrepresents the product on a live listing. Fill
 * percentage was never the risk that mattered; it was simply the one V1's shot list could
 * produce.
 *
 * ## The division of labour, kept strict
 *
 *   deterministic   geometry, background purity, resolution, crop — computed, then handed
 *                   to the reviewer as fact so it never estimates them
 *   model           likeness, legibility of markings, anatomy, physical plausibility,
 *                   and whether the image answers the brief at all
 *
 * The verdict is then gated in code (see `gateVerdict`): a blocker defect cannot pass
 * however the model scored it, and a locked slot cannot pass while the measured compliance
 * says otherwise. The model's judgement is an input to the decision, not the decision.
 *
 * ## Seeing the real photographs is the whole mechanism
 *
 * A reviewer shown only the candidate can judge whether it is a good photograph. Only a
 * reviewer shown the seller's originals alongside it can judge whether it is a photograph
 * of the seller's product, and that is the failure worth catching. The references passed
 * here are the ones the shot was routed to and rendered from — the same photographs, so a
 * defect the reviewer reports is a real difference rather than an artefact of comparing
 * against a surface the generator never saw.
 */

import { CLAUDE_MAX_TOKENS, MODELS } from '../config'
import { claude, firstText, labelledImageBlocks, parseJson } from './client'
import { renderDNA, type ImageDNA } from './dna'
import { slotHardRules, type Slot } from '../slots'
import { rulesFor } from '../amazon/rules'
import type { Base64Image } from '../photos'
import type { ComplianceReport } from '../compliance'
import type { ClaudeUsage } from '../cost'

export type DefectKind =
  /** The product in the image is not quite the product in the photographs. */
  | 'identity-drift'
  /** Text, a logo, or a marking is misspelled, re-lettered, re-spaced, or invented. */
  | 'wrong-marking'
  /** A surface no photograph shows has been rendered anyway. */
  | 'invented-surface'
  /** Hands, limbs, or bodies are malformed or miscounted. */
  | 'anatomy'
  /** Body and product intersect impossibly, or the grip is not physically real. */
  | 'implausible-contact'
  /** Warping, smearing, melted geometry, duplicated parts, nonsense texture. */
  | 'artifact'
  /** The image does not show what the shot asked for. */
  | 'off-brief'
  /** The shot asked for a different view and returned the reference's view again. */
  | 'duplicate-view'
  /** A hard rule for this slot is violated — a prop, text, a person where none is allowed. */
  | 'rule-violation'
  /** Framing, crop, or composition problem a human would call badly shot. */
  | 'framing'
  /** Lighting, exposure, focus, or colour cast that would look wrong on a listing. */
  | 'quality'

export type Severity =
  /** Ships a misrepresentation, or is grotesque. Cannot pass. */
  | 'blocker'
  /** Clearly wrong and worth another attempt, but not misleading. */
  | 'major'
  /** Noticeable, not worth spending another generation on by itself. */
  | 'minor'

export type Defect = {
  kind: DefectKind
  severity: Severity
  /** What is wrong, concretely enough that the prompt writer can act on it. */
  description: string
  /** Where in the image, and what in the reference photos proves it. */
  evidence: string
}

export type ReviewScores = {
  /** Is this the same physical product as the photographs? The one that matters most. */
  identity: number
  /** Does the image show what the shot asked for? */
  brief: number
  /** Does it read as a real photograph rather than a generated one? */
  realism: number
}

export type Verdict = 'pass' | 'retry' | 'reject'

export type RetryStrategy =
  /** A rewritten prompt has a real chance. */
  | 'rewrite-prompt'
  /** The generator is being led astray by the references it was given. */
  | 'reroute-photos'
  /** No prompt fixes this; the seller has to photograph the surface. */
  | 'needs-new-photo'
  /** Nothing left to try. Keep the best attempt and say so. */
  | 'accept-best'

export type Review = {
  verdict: Verdict
  scores: ReviewScores
  defects: Defect[]
  /** Concrete instruction for the next prompt. Empty when the verdict is 'pass'. */
  fixInstructions: string
  retryStrategy: RetryStrategy
  /** Plain-language sentence for the seller when this cannot be fixed by regenerating. */
  sellerNote: string
  /** One line the run report can print. */
  summary: string
}

/** Identity below this is a different product, whatever else is right about the image. */
export const IDENTITY_FLOOR = 75
/** Brief below this means the image did not do the job it was generated for. */
export const BRIEF_FLOOR = 65

const SCHEMA = {
  type: 'object',
  properties: {
    scores: {
      type: 'object',
      properties: {
        identity: {
          type: 'integer',
          description:
            '0-100. Is the object in the candidate the same physical product as the one in the reference photographs? 100 = indistinguishable. 75 = a buyer would accept it. 50 = recognisably the same kind of thing but not the same item. 0 = a different product.',
        },
        brief: {
          type: 'integer',
          description:
            '0-100. Does the candidate show what the shot asked for — the right viewpoint, the right surface, the right framing, the right kind of photograph?',
        },
        realism: {
          type: 'integer',
          description:
            '0-100. Does it read as a real photograph? Deduct for warping, smeared texture, impossible geometry, malformed hands, plastic-looking skin, or a lighting setup no camera would produce.',
        },
      },
      required: ['identity', 'brief', 'realism'],
      additionalProperties: false,
    },
    defects: {
      type: 'array',
      description:
        'Every fault worth naming, worst first. Empty array if the image is genuinely sound.',
      items: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [
              'identity-drift',
              'wrong-marking',
              'invented-surface',
              'anatomy',
              'implausible-contact',
              'artifact',
              'off-brief',
              'duplicate-view',
              'rule-violation',
              'framing',
              'quality',
            ],
          },
          severity: {
            type: 'string',
            enum: ['blocker', 'major', 'minor'],
            description:
              'blocker = shipping this would misrepresent the product, or it is grotesque. major = clearly wrong, worth another generation. minor = noticeable but not worth another generation on its own.',
          },
          description: {
            type: 'string',
            description:
              'What is wrong, concretely. Name the actual thing: "the logo reads LARSON; the photographs read LARSEN".',
          },
          evidence: {
            type: 'string',
            description:
              'Where in the candidate, and what in the reference photographs proves it. Cite the photo by its label.',
          },
        },
        required: ['kind', 'severity', 'description', 'evidence'],
        additionalProperties: false,
      },
    },
    fixInstructions: {
      type: 'string',
      description:
        'What the next prompt must say differently, written for the prompt author. Concrete and specific — name the correct wording, the correct grip, the correct viewpoint. Not "improve accuracy". Empty string if there is nothing to fix.',
    },
    retryStrategy: {
      type: 'string',
      enum: ['rewrite-prompt', 'reroute-photos', 'needs-new-photo', 'accept-best'],
      description:
        'rewrite-prompt = a differently worded prompt has a real chance. reroute-photos = the reference photographs supplied are the problem; a different photo from the set would do better. needs-new-photo = no prompt fixes this because the surface is not in any photograph. accept-best = the remaining faults are minor and another attempt is unlikely to beat this one.',
    },
    sellerNote: {
      type: 'string',
      description:
        'One plain sentence for the seller, only when this cannot be fixed by regenerating — what to photograph, or why this shot is not available. Empty string otherwise.',
    },
    summary: {
      type: 'string',
      description: 'One line describing the state of this image, for a run report.',
    },
  },
  required: ['scores', 'defects', 'fixInstructions', 'retryStrategy', 'sellerNote', 'summary'],
  additionalProperties: false,
} as const

const SYSTEM = `You review a generated product photograph before it reaches a live marketplace listing. You are shown the seller's real photographs of the product, then the candidate image generated from them, then the brief the candidate was generated against.

Your question is not "is this a nice image". It is: **would publishing this misrepresent the product a buyer is about to pay for?**

## What you are judging, in order

**1. Identity.** Is the object in the candidate the same physical item as the one in the reference photographs? Compare deliberately rather than at a glance: the silhouette and the proportions between parts, the colours, the material and finish, the placement and size of every marking, the count of repeated elements — stitches, holes, ridges, buttons, panels. Generated images fail here subtly and confidently. A shape that is close but a little rounder, a colour a little warmer, a panel seam that has moved, a strap that has gained a keeper: each is a different product for sale.

**2. Markings.** Any text, logo, or printed mark is checked character by character against the photographs. Image models re-letter text while preserving its look, and a logo reading LARSON where the product reads LARSEN is a blocker no matter how well the rest is rendered. Also check letterform, weight, spacing, and position. If a marking is present in the candidate and legible in no reference photograph, it was invented — that is a blocker too.

**3. Invented surfaces.** The brief lists which reference photographs were supplied. If the candidate shows a surface that appears in NONE of them — the underside of something photographed only from above, a rear face, the inside of something closed — the generator has invented it. Report it as invented-surface, blocker. Plausibility is not the test; that surface may carry a maker's stamp, a defect, or a different colour on the real item.

**4. Anatomy and contact,** where a person appears. Count fingers. Check that hands, wrists, arms and shoulders join and proportion normally, and that any face is unremarkable. Check that the grip is one a person could actually make on this object, that nothing passes through anything, and that the contact reads as weight-bearing rather than floating. Malformed anatomy is a blocker: it is the most recognisable signature of a generated image and it destroys trust in the listing.

**5. The brief.** Does the image show what was asked for? A macro that is not close up, a grip shot with no hands, a plain-background shot with a scene: off-brief.

duplicate-view applies to ONE case: the shot asked for a camera position the reference photographs do not provide, and the candidate came back at the reference's viewpoint instead. That is a real failure — it costs the listing a shot while appearing to succeed.

It does not apply anywhere else, and in particular:

- On a **detail** shot, matching the reference surface exactly is the goal, not a fault. The correct way to produce a macro of a real surface is to reproduce that surface, and a candidate indistinguishable from the reference crop is a complete success. Never report duplicate-view, off-brief, or identity-drift because a detail candidate is "too close to the reference" or "unchanged from the source".
- On an **angle** shot, the viewpoint is supposed to come from one of the supplied photographs. A candidate matching the photograph it was routed to is correct. Report duplicate-view only when the candidate shows a DIFFERENT viewpoint from the one the shot asked for — typically the main frontal view when a side or rear was required.
- On **context**, **scale** and **in-use** shots, the product is supposed to be unchanged; only the surroundings are new.

Where a candidate reproduces real pixels faithfully, say so and pass it. Fidelity to the seller's photographs is what this pipeline is for, and a reviewer that treats fidelity as laziness rejects its own best output and spends the retry budget asking a generator to invent differences.

**6. Hard rules.** The brief lists them. A person, prop, surface, or text where the rules forbid one is a rule-violation blocker, however good the image is.

## What NOT to judge

You are looking at the raw generated image. A deterministic pass runs AFTER you and before
anything is published, and it fixes a specific list of things exactly. Do not judge them and
do not report defects about them, because a retry cannot improve what is already going to be
corrected, and every retry spent on one is a retry not spent on a real fault:

- Whether the background is numerically exactly RGB(255,255,255). It will be composited onto
  literal white. No generator outputs mathematically flat white and asking for it again does
  not change that.
- The exact frame-fill percentage. The product will be cropped to its bounds and padded to
  the exact target.
- Whether the product sits perfectly centred, and how wide the margins are.
- Resolution, pixel dimensions, file format, and file size. Every image is upscaled to the
  platform target.

What you DO judge about the background on a main image is its **content**, which no pass can
fix: a coloured, textured, gradient or patterned backdrop, a visible surface, table, floor,
cloth or plinth under the product, a cast shadow, a border, matte, frame or inset panel, a
second object, or anything else in frame that is not the product. Those are the generator
producing the wrong picture, and they are exactly what a retry can fix.

Do not deduct for a background, setting, or lighting the brief legitimately allowed the
generator to choose. Inventing the setting is the job on those shots. Where the brief states
a fixed lighting setup, shadow treatment or setting from the platform style grid, DO check
the image actually follows it — drifting off the grid is a real defect, because the whole
listing has to look like one session.

## Severity, and being decisive

Be strict on identity and markings, and be strict on anatomy. Be generous on taste. A slightly dull lighting choice is minor; a re-lettered logo is a blocker. Do not pad the defect list with things you would not regenerate over — every defect you report costs a generation, and a list of nine minor observations buries the one that matters.

Say plainly when an image is good. A reviewer that never passes anything is a reviewer that burns the retry budget on every shot and ships the third attempt regardless.

## fixInstructions

This is read by the author of the next prompt, who cannot see the image. Tell them what to say differently, concretely: the exact wording a marking must carry, which hand grips where, what viewpoint was asked for and what came back instead. "Improve product accuracy" changes nothing about the next generation. "State that the handle is wrapped in black grip tape with three raised rings, and that the wording on the spine reads SS TON in white block capitals" does.

Choose retryStrategy honestly. If the fault is that no photograph shows the surface, no prompt fixes it: say needs-new-photo and write the seller a sentence telling them what to photograph. If the remaining faults are minor, say accept-best rather than spending another generation to trade them for different minor faults.`

export type ReviewInput = {
  dna: ImageDNA
  slot: Slot
  /** The prompt that produced the candidate. */
  prompt: string
  /** The photos the shot was rendered from, in the order the generator received them. */
  references: Base64Image[]
  candidate: Base64Image
  /** Measured geometry, for slots where it applies. Handed over as fact, never estimated. */
  compliance?: ComplianceReport
  /** Which attempt this is, 1-based. Shown to the reviewer so it can stop escalating. */
  attempt?: number
  /** How many attempts remain after this one. */
  attemptsLeft?: number
}

export async function reviewImage(
  input: ReviewInput,
): Promise<{ review: Review; usage: ClaudeUsage; ms: number }> {
  const started = Date.now()

  const response = await claude().messages.create({
    model: MODELS.claude,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `The seller's real photographs of the product (${input.references.length}):`,
          },
          ...labelledImageBlocks(input.references, (i) => `Reference photo ${i + 1}`),
          { type: 'text', text: 'The candidate image generated from them:' },
          ...labelledImageBlocks([input.candidate], () => 'CANDIDATE'),
          { type: 'text', text: buildReviewBrief(input) },
        ],
      },
    ],
  })

  const raw = parseJson<Omit<Review, 'verdict'>>(firstText(response), 'Image review')
  return {
    review: gateVerdict(raw, input),
    usage: response.usage as ClaudeUsage,
    ms: Date.now() - started,
  }
}

function buildReviewBrief(input: ReviewInput): string {
  const { slot, dna } = input
  const parts: string[] = [
    '## The brief this candidate was generated against',
    '',
    `Shot: ${slot.label}`,
    `Kind: ${slot.kind ?? 'angle'}`,
    `What it should show: ${slot.directive}`,
    '',
    '## The real product, as catalogued from the photographs',
    renderDNA(dna),
  ]

  if (dna.absentSurfaces.length) {
    parts.push(
      '',
      '## Surfaces NO photograph shows',
      'If the candidate depicts any of these, the generator invented it:',
      ...dna.absentSurfaces.map((s) => `- ${s}`),
    )
  }

  const rules = slotHardRules(slot)
  if (rules.length) {
    parts.push('', '## Hard rules for this shot', ...rules.map((r) => `- ${r}`))
  }

  // The marketplace rules the image is actually published under. Given to the reviewer
  // verbatim rather than paraphrased, so it checks the same text the prompt writer was
  // handed — a rule enforced at write time and not at review time is not enforced.
  const marketplace = rulesFor({
    category: dna.amazonCategory,
    isMain: slot.mode === 'locked',
  })
  if (marketplace.length) {
    parts.push(
      '',
      `## Marketplace rules for this position (${slot.mode === 'locked' ? 'MAIN image' : 'secondary image'}, category: ${dna.amazonCategory})`,
      'An image breaking any of these cannot be published at all.',
      ...marketplace.map((r) => `- ${r}`),
    )
  }

  if (input.compliance) {
    const c = input.compliance
    parts.push(
      '',
      '## Measured geometry (computed, not estimated — treat as fact)',
      `- Background: max deviation ${c.bgMaxDeviation}/255 from pure white, ${c.bgPureWhitePct}% of background pixels exactly 255`,
      `- Frame fill: ${c.fillLinearPct}% on the longer axis (requirement is 85% or more)`,
      `- Product touches the frame edge: ${c.touchesEdge ? 'YES' : 'no'}`,
      `- Resolution: ${c.width}×${c.height}`,
      '',
      'These are already measured and, where fixable, already corrected. Do not re-judge ' +
        'them and do not report defects about them.',
    )
  }

  parts.push(
    '',
    '## The prompt that produced the candidate',
    input.prompt,
  )

  if (input.attempt && input.attempt > 1) {
    parts.push(
      '',
      `## Attempt ${input.attempt}`,
      `${input.attemptsLeft ?? 0} attempt(s) remain after this one. If the remaining ` +
        'faults are minor, or if repeated attempts are not converging, say accept-best ' +
        'rather than spending another generation.',
    )
  }

  return parts.join('\n')
}

/**
 * The verdict is decided here, not by the model.
 *
 * The model contributes judgement it is genuinely better at — likeness, legibility,
 * anatomy — and code contributes the parts that must not be negotiable. Three gates, each
 * for a failure seen in practice:
 *
 *  - A blocker defect cannot pass. A model that has just written "the logo reads LARSON;
 *    the photographs read LARSEN" will still sometimes return an approving verdict,
 *    because the image is otherwise excellent and the pull towards approval is strong.
 *  - A locked slot cannot pass while the MEASURED compliance says it is not ready. This is
 *    the deterministic half of the pipeline, and no model opinion overrides it.
 *  - Scores below the floors cannot pass, so an approving verdict has to be consistent
 *    with the numbers the same response reported.
 *
 * The reverse gate matters as much: a review with no blocker and good scores passes even
 * if the model listed three minor gripes, because the alternative is spending the whole
 * retry budget chasing taste.
 */
export function gateVerdict(raw: Omit<Review, 'verdict'>, input: ReviewInput): Review {
  const defects = raw.defects ?? []
  const hasBlocker = defects.some((d) => d.severity === 'blocker')
  const hasMajor = defects.some((d) => d.severity === 'major')
  const scores = raw.scores

  // Measured compliance is normally absent now: review runs on the raw image, before the
  // deterministic pass (spec §11 -> §12). It is still honoured when a caller supplies it —
  // /api/review re-reviews already-corrected images — because a measurement that says the
  // released file is non-compliant must outrank an approving model verdict either way.
  const complianceFails =
    input.slot.mode === 'locked' && input.compliance ? !input.compliance.amazonReady : false

  const identityFails = scores.identity < IDENTITY_FLOOR
  const briefFails = scores.brief < BRIEF_FLOOR

  let verdict: Verdict = 'pass'
  if (hasBlocker || complianceFails || identityFails || briefFails) {
    // 'reject' means "stop retrying", not "worse than retry". It is reserved for faults a
    // differently worded prompt cannot reach — the surface is in no photograph — because
    // retrying those burns the budget to arrive at the same answer three attempts later.
    verdict = raw.retryStrategy === 'needs-new-photo' ? 'reject' : 'retry'
  } else if (hasMajor) {
    verdict = raw.retryStrategy === 'accept-best' ? 'pass' : 'retry'
  }

  const notes: string[] = []
  if (complianceFails) {
    notes.push(
      'Measured compliance still failing after correction: ' +
        (input.compliance?.notes.join(' ') ?? ''),
    )
  }

  return {
    ...raw,
    defects,
    verdict,
    summary: notes.length ? `${raw.summary} ${notes.join(' ')}`.trim() : raw.summary,
  }
}

/**
 * Rank attempts so the loop can ship the best one when none passed.
 *
 * Identity dominates deliberately. Shipping a beautiful photograph of the wrong product is
 * the failure this whole stage exists to prevent, so an attempt that is merely dull beats
 * one that is merely inaccurate. Blockers are subtracted rather than disqualifying, because
 * this ranking only runs once every attempt has one.
 */
export function scoreReview(review: Review): number {
  const { identity, brief, realism } = review.scores
  const blockers = review.defects.filter((d) => d.severity === 'blocker').length
  const majors = review.defects.filter((d) => d.severity === 'major').length
  return identity * 3 + brief * 2 + realism - blockers * 40 - majors * 10
}

/** One line per defect, in the shape the prompt writer's feedback block wants. */
export function defectLines(review: Review): string[] {
  return review.defects.map(
    (d) => `[${d.severity}/${d.kind}] ${d.description} (${d.evidence})`,
  )
}
