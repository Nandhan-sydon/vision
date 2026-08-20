/**
 * Stage 1.5 — the shot plan, now with coverage analysis.
 *
 * A fixed slot list cannot be right for every product: a shoe needs a sole shot, a watch
 * needs a caseback, a cricket bat needs the toe, the spine, the grip in a hand and the
 * face at the point of contact. The correct shot list is a property of the product, so
 * Claude derives it per product rather than us enumerating it up front.
 *
 * What the photo set adds is COVERAGE ROUTING, and it is the change that resolves V1's
 * central negative finding rather than working around it.
 *
 * V1 measured that `images.edit` cannot move the camera — it is structurally anchored to
 * the reference composition — and that dropping the reference to move it instead
 * distorted the product (height:width 0.89 → 0.66, a 26% squatter object). The conclusion
 * was that pose is not achievable. That conclusion holds, and it stops mattering: with
 * several photos, a side view is no longer a pose to synthesise. It is a photograph the
 * seller already took, and rendering it is an `edit` anchored on THAT photo, which is the
 * route where identity held to 2%.
 *
 * So this stage answers, per shot, "which photograph is this shot an edit of?" A shot with
 * an answer is rendered from that photo. A shot with no answer is not rendered at all — it
 * is handed back to the seller as a photograph to take, with a plain-language description
 * of the photograph needed. That refusal is the differentiator: producing seven images
 * from one photo is only possible by inventing five of them.
 *
 * Two things this deliberately does NOT do:
 *
 *  - It does not choose the Main shot. Main is a compliance slot with fixed hard rules
 *    and is injected unconditionally, never left to the model's judgement.
 *  - It does not assume every good shot is achievable.
 */

import { CLAUDE_MAX_TOKENS, MODELS } from '../config'
import { claude, firstText, parseJson } from './client'
import { renderCoverage, renderDNA, usablePhotoIndexes, type ImageDNA } from './dna'
import { getSlot, type ShotKind, type Slot } from '../slots'
import { photoLabel, toIndexes } from '../photos'
import { CATEGORY_RULES, categoryNote } from '../amazon/rules'
import type { ClaudeUsage } from '../cost'

export type Feasibility =
  /** A supplied photo shows every surface this shot needs, from a workable viewpoint. */
  | 'derivable'
  /** Partly shown — plausible, but the model must extrapolate some of it. */
  | 'partial'
  /** No photo shows what this shot needs. Requires a real photograph. */
  | 'needs-new-photo'

export type PlannedShot = Slot & {
  kind: ShotKind
  feasibility: Feasibility
  /** Why this shot suits this particular product. Shown in the report, not to the buyer. */
  rationale: string
  /**
   * The photograph the seller should take to unlock this shot, in their own terms.
   * Populated for 'needs-new-photo' and 'partial'; empty otherwise.
   */
  requiredPhoto: string
}

export type ShotPlan = {
  productSummary: string
  shots: PlannedShot[]
  /** Plain-language coverage verdict for the seller. */
  coverageSummary: string
}

const SCHEMA = {
  type: 'object',
  properties: {
    productSummary: {
      type: 'string',
      description: 'One line: what this product is and what a buyer needs to see to judge it.',
    },
    coverageSummary: {
      type: 'string',
      description:
        'One or two sentences for the seller: how many of the shots their photographs cover, and what one more photograph would unlock. Plain language, no jargon.',
    },
    shots: {
      type: 'array',
      description:
        'Five to seven supporting shots, best first. Do not include the main catalogue shot.',
      items: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'kebab-case identifier, e.g. "sole", "caseback", "grip-in-hand".',
          },
          label: { type: 'string', description: 'Two or three words for the UI.' },
          kind: {
            type: 'string',
            enum: ['angle', 'detail', 'in-use', 'scale', 'context', 'packaging'],
            description:
              'angle = same product, different camera position. detail = macro on one surface. in-use = a person using, wearing or holding it. scale = size conveyed against a reference. context = the product in a setting with no person. packaging = box or what-is-included.',
          },
          directive: {
            type: 'string',
            description:
              'What the photograph shows: subject, viewpoint, framing. Written for a prompt author, not a buyer.',
          },
          sourcePhotos: {
            type: 'array',
            description:
              'The photo numbers, as labelled, that this shot should be built from. The single best photo first. Empty array ONLY when no photo supports the shot at all.',
            items: { type: 'integer' },
          },
          requiresViewpointChange: {
            type: 'boolean',
            description:
              'True if this shot needs a camera position that NONE of the supplied photographs provides. False when one of the photographs is already taken from the viewpoint this shot needs, even if that is a different viewpoint from the main shot.',
          },
          feasibility: {
            type: 'string',
            enum: ['derivable', 'partial', 'needs-new-photo'],
            description:
              'derivable = a supplied photo shows every surface this shot needs, from a workable viewpoint. partial = partly shown, some extrapolation required. needs-new-photo = no photo shows what this shot needs.',
          },
          requiredPhoto: {
            type: 'string',
            description:
              'For partial and needs-new-photo: the photograph the seller should take, described so they can act on it without technical knowledge. Empty string for derivable.',
          },
          rationale: {
            type: 'string',
            description: 'Why a buyer of THIS product needs this shot.',
          },
        },
        required: [
          'id',
          'label',
          'kind',
          'directive',
          'sourcePhotos',
          'requiresViewpointChange',
          'feasibility',
          'requiredPhoto',
          'rationale',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['productSummary', 'coverageSummary', 'shots'],
  additionalProperties: false,
} as const

const SYSTEM = `You plan the photograph set for a product listing. You are given a structured record of a real product, and a coverage map of the photographs the seller supplied: which photo was taken from which viewpoint, what each one shows, and which surfaces no photo shows at all. You return the supporting shots that listing should contain, and you route each one to the photographs that can actually produce it.

## Choose shots that suit THIS product

The right set differs by category and you should let it. Footwear needs the sole and the profile; a watch needs the caseback and the clasp; a book needs the back cover and a spread; a garment needs it worn and the fabric close up; a cricket bat needs the full face, the spine, the toe, the grip, and the bat in a batsman's hands at address; a framed print needs it hung and the corner detail. Do not default to a generic rotation series.

A shot earns its place only if a buyer would actually want it before purchasing. Order the shots best-first, so a seller who only uses two gets the two that matter most. Return five to seven.

## Cover the four things a buyer decides on

Across the set, aim to answer all four of these, in as many shots as it takes:

1. **Form** — the product's shape from the angles that reveal it. Use the viewpoints the photographs actually give you.
2. **Quality** — at least one macro on the surface that carries this product's quality: the weave, the grain, the stitching, the machining, the pressing, the finish. This is where a buyer decides the product is or is not well made.
3. **Use** — at least one shot of the product being used, worn, or held by a person, whenever the product is something a person handles or wears. Not a decorative scene: the moment of use, framed so a buyer sees how it sits in a hand or on a body. For a bat that is a batsman's grip at address, close enough that the hands on the handle and the face of the bat are both legible. Skip this only where a person genuinely has no place in the product's use.
4. **Scale** — how big it really is, whenever the photographs alone would leave that ambiguous.

Mark each shot's kind accordingly. A person may appear only in an 'in-use' or 'scale' shot; 'angle', 'detail' and 'context' shots have no person in frame.

## Respect the category's rules when choosing shots

The request states the marketplace ruleset this product falls under, and it constrains the
set. Some shots are forced OUT of the main position and INTO your list: footwear puts the
pair and every worn shot in the supporting shots because the main image may only show a
single shoe. Some are forbidden outright: a kids' apparel product is never shown on a child
model in underwear, swimwear, or a leotard-type garment, in any position, so do not propose
it. Do not propose a shot the rules would not allow to be published.

## Route every shot to a photograph

For each shot, put in sourcePhotos the photo numbers that shot should be built from, best first. This is the most consequential field you fill in.

The rule is simple and strict: a shot is built from photographs that actually show the surfaces it needs. If a shot needs the underside, route it to a photo the coverage map says shows the underside — never to a photo of the front on the theory that the underside can be continued from it.

An 'in-use' shot is routed to the photographs that best show the product as it will appear in the frame — the surfaces facing the camera in your directive. The person is new; the product is not, and it has to come from somewhere.

Set requiresViewpointChange TRUE only when the shot needs a camera position that none of the supplied photographs provides. If one of the photographs is already taken from the viewpoint the shot needs, it is FALSE — even though that viewpoint differs from the main shot. This distinction decides whether the shot is produced from a real photograph or attempted from a text description, and getting it wrong yields either a duplicate of the main shot or a distorted product.

## Judge feasibility against the coverage map, strictly

Mark a shot "derivable" only when a supplied photo actually shows every surface it needs, from a workable viewpoint, and that photo is not marked unusable.

Mark it "partial" when the surface is partly visible, or shown only at a glancing angle or too small to read, so some of it would have to be extrapolated.

Mark it "needs-new-photo" when nothing in the set shows what the shot needs. The record's list of absent surfaces is authoritative here: if a surface is on that list, any shot needing it is needs-new-photo, however much the listing would benefit.

A "needs-new-photo" verdict is a useful answer, not a failure. Propose the shot anyway when the product genuinely calls for it, and describe in requiredPhoto the photograph the seller should take — plainly, so they can act on it without technical knowledge: "the bottom of the bat standing on its toe, so the grain at the toe guard is visible". Telling the seller which photograph to take is worth more than inventing a surface that may not match the real item.

## coverageSummary

Write the seller one honest sentence about where they stand: how many of the shots their photographs already cover, and what a single further photograph would unlock. This is the answer they act on.

Do not propose the main catalogue shot — it is fixed and handled separately.`

export async function planShots(
  dna: ImageDNA,
): Promise<{ plan: ShotPlan; usage: ClaudeUsage; ms: number }> {
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
          '## Product',
          renderDNA(dna),
          '',
          '## Photograph coverage',
          renderCoverage(dna),
          '',
          '## Marketplace rules that shape this shot list',
          categoryNote(dna.amazonCategory),
          ...(CATEGORY_RULES[dna.amazonCategory]?.main ?? []).map((r) => `- MAIN: ${r}`),
          ...(CATEGORY_RULES[dna.amazonCategory]?.secondary ?? []).map(
            (r) => `- SECONDARY: ${r}`,
          ),
        ].join('\n'),
      },
    ],
  })

  const raw = parseJson<{
    productSummary: string
    coverageSummary: string
    shots: {
      id: string
      label: string
      kind: ShotKind
      directive: string
      sourcePhotos: number[]
      requiresViewpointChange: boolean
      feasibility: Feasibility
      requiredPhoto: string
      rationale: string
    }[]
  }>(firstText(response), 'Shot plan')

  const usable = new Set(usablePhotoIndexes(dna))

  const plan: ShotPlan = {
    productSummary: raw.productSummary,
    coverageSummary: raw.coverageSummary,
    shots: raw.shots.map((s) => {
      // Photos the fingerprint marked unusable are dropped from routing here rather than
      // at render time: a blurred frame is a worse reference than a sharp frame of an
      // adjacent surface, and the two stages must not disagree about which photos exist.
      const routed = toIndexes(s.sourcePhotos ?? [], dna.photoCount).filter((i) =>
        usable.has(i),
      )

      return {
        id: s.id,
        label: s.label,
        mode: 'creative' as const,
        kind: s.kind,
        directive: s.directive,
        sourcePhotos: routed,
        // A routed shot is an edit of a real photograph, whatever viewpoint it shows —
        // that is the whole point of taking several. 'compose' is reserved for shots no
        // photograph supports, where it is the only route left and a poor one.
        renderMode: routed.length > 0 ? ('edit' as const) : ('compose' as const),
        feasibility: s.feasibility,
        requiredPhoto: s.requiredPhoto ?? '',
        rationale: s.rationale,
      }
    }),
  }

  return { plan, usage: response.usage as ClaudeUsage, ms: Date.now() - started }
}

export type SlotSet = {
  slots: Slot[]
  deferred: PlannedShot[]
  /** Per-shot record of why each deferred shot was held back. Reported, not guessed at. */
  deferrals: { id: string; label: string; reason: string; requiredPhoto: string }[]
}

/**
 * The slots actually generated: the compliance-locked Main shot, then whichever planned
 * shots a supplied photograph can actually produce.
 *
 * A shot is held back for either of two reasons, and they are different failures:
 *
 *   no supporting photograph  — nothing in the set shows what the shot needs, so it would
 *                               have to be invented. Deferred regardless of settings,
 *                               unless allowCompose is explicitly turned on.
 *   surface not really shown  — feasibility 'needs-new-photo'. Deferred on the strength of
 *                               the coverage map even if the model routed it somewhere.
 *
 * `includePartial` defaults to true because 'partial' means "extrapolate the edges of
 * something we can see", which the reviewer then checks — a different risk from inventing
 * a surface outright.
 *
 * Main is routed too. It gets the photographs that best show the product straight-on,
 * falling back to the whole usable set, because a hero shot rendered from a glancing
 * three-quarter frame starts out non-compliant on framing.
 */
export function buildSlotSet(
  plan: ShotPlan,
  dna: ImageDNA,
  opts: { includePartial?: boolean; allowCompose?: boolean } = {},
): SlotSet {
  const usable = opts.includePartial === false ? ['derivable'] : ['derivable', 'partial']
  const allowCompose = opts.allowCompose ?? false

  const main: Slot = { ...getSlot('main'), sourcePhotos: mainPhotos(dna) }
  const slots: Slot[] = [main]
  const deferred: PlannedShot[] = []
  const deferrals: SlotSet['deferrals'] = []

  for (const shot of plan.shots) {
    const unsupported = (shot.sourcePhotos ?? []).length === 0
    const infeasible = !usable.includes(shot.feasibility)

    let reason = ''
    if (infeasible) {
      reason =
        shot.feasibility === 'needs-new-photo'
          ? 'No uploaded photo shows the surface this shot needs.'
          : `Feasibility "${shot.feasibility}" is excluded by this run's settings.`
    } else if (unsupported && !allowCompose) {
      reason =
        'No uploaded photo supports this viewpoint, so it could only be described to the ' +
        'generator rather than rendered from a real photograph.'
    }

    if (reason) {
      deferred.push(shot)
      deferrals.push({
        id: shot.id,
        label: shot.label,
        reason,
        requiredPhoto: shot.requiredPhoto,
      })
    } else {
      slots.push(shot)
    }
  }

  return { slots, deferred, deferrals }
}

/**
 * Which photographs the Main shot is rendered from.
 *
 * Prefers whichever usable photo the fingerprint describes as a front or straight-on
 * view, since Main is a straight-on hero and its hard rules are about framing. Falls back
 * to every usable photo, then to every photo — Main is the one shot that must always be
 * attempted, so it never routes to nothing.
 */
function mainPhotos(dna: ImageDNA): number[] {
  const usable = dna.photos.filter((p) => p.usable)
  const frontish = usable.filter((p) =>
    /front|straight|head[- ]?on|face|frontal/i.test(p.viewpoint),
  )
  if (frontish.length) return frontish.map((p) => p.index)
  if (usable.length) return usable.map((p) => p.index)
  return dna.photos.map((p) => p.index)
}

/** One line per shot, for scripts and the run report. */
export function renderPlan(plan: ShotPlan, set: SlotSet): string {
  const lines: string[] = [plan.productSummary, '', plan.coverageSummary, '']

  for (const slot of set.slots) {
    const where = slot.sourcePhotos?.length
      ? slot.sourcePhotos.map((i) => photoLabel(i)).join(' + ')
      : 'no photo (composed from text)'
    const kind = slot.kind ?? 'angle'
    lines.push(`GENERATE  ${slot.label} [${kind}] ← ${where}`)
  }
  for (const d of set.deferrals) {
    lines.push(`DEFER     ${d.label} — ${d.reason}`)
    if (d.requiredPhoto) lines.push(`          take: ${d.requiredPhoto}`)
  }
  return lines.join('\n')
}
