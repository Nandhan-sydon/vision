/**
 * Slot registry — the reusability seam (spec §10).
 *
 * The pipeline knows only the `Slot` shape. Everything domain-specific is data in this
 * file. Adding a blog-image pack later means adding another array here; nothing in
 * `lib/claude/` or `lib/generators/` needs to change or even know this domain exists.
 */

export type SlotMode =
  /** Hard rules are absolute and beat any user hint. */
  | 'locked'
  /** Claude has real latitude; the hint is a genuine input. */
  | 'creative'

/**
 * How the image is produced.
 *
 * 'edit'    — anchored to the uploaded photo (OpenAI images.edit / Gemini image+text).
 *             Preserves identity almost perfectly, but CANNOT change the camera pose:
 *             the endpoint is structurally locked to the reference composition.
 * 'compose' — built from the Visual DNA as text, with no reference image. This is the
 *             only way measured to actually change viewpoint, at the cost of some
 *             identity drift, so it is used only where the shot genuinely needs it.
 */
export type RenderMode = 'edit' | 'compose'

/**
 * What kind of photograph this is.
 *
 * The kind is not a label for the UI — it decides three things the pipeline cannot infer
 * from the directive text: which invariants are injected into the prompt (KIND_RULES),
 * how strictly the reviewer judges the product's likeness, and whether a human being may
 * appear at all. A cricket bat's listing wants a grip macro AND a batsman holding it, and
 * those two shots need opposite instructions about invention: the macro may invent
 * nothing, while the batsman is necessarily invented around a product that is not.
 */
export type ShotKind =
  /** The compliance hero: product alone on white. Only the `main` slot is this. */
  | 'catalogue'
  /** The same product from a viewpoint another photo supplies. */
  | 'angle'
  /** A macro on one surface — material, texture, stitching, grain, a marking. */
  | 'detail'
  /** A person using, wearing, or holding the product. The person is invented; the product is not. */
  | 'in-use'
  /** The product beside a size reference, or held, to convey scale. */
  | 'scale'
  /** The product in a setting where it belongs, with no person in frame. */
  | 'context'
  /** Box, case, or what-is-included. Only where a photo actually shows it. */
  | 'packaging'

export type Slot = {
  id: string
  label: string
  mode: SlotMode
  /** Defaults to 'edit'. Set 'compose' only when the camera viewpoint must change. */
  renderMode?: RenderMode
  /** Defaults to 'angle'. Drives KIND_RULES and the reviewer's strictness. */
  kind?: ShotKind
  /** What this slot should show. Written for Claude, not for the end user. */
  directive: string
  /** Non-negotiable constraints, injected into every prompt for this slot. */
  hardRules?: string[]
  /**
   * Indexes into the uploaded photo array that actually support this shot, from the shot
   * plan's coverage analysis. The renderer hands the generator ONLY these photos, and the
   * reviewer compares against only these photos. Empty or absent means "the whole set".
   */
  sourcePhotos?: number[]
}

/**
 * Invariants per shot kind, injected into every prompt for a slot of that kind.
 *
 * These exist because the single most damaging failure mode is not a weak photograph, it
 * is a convincing photograph of a product that is subtly not the one being sold. The
 * rules are phrased as what the generator must do, because that is how they reach the
 * prompt.
 *
 * `in-use` carries the most, and deliberately so. It is the only kind where invention is
 * licensed, so it is the only kind that needs the boundary of that licence spelled out:
 * the person, the setting and the light are invented; the product's geometry, colour,
 * markings and proportions are not. It is also where a generator's failures become
 * grotesque rather than merely wrong — six-fingered hands, a bat fused to a forearm — so
 * the anatomy and contact rules are stated as constraints rather than left to taste.
 */
export const KIND_RULES: Record<ShotKind, string[]> = {
  catalogue: [],
  angle: [
    'The product is the same physical object seen from a different camera position — its proportions, markings, and colour are identical to the reference photographs, with only the viewpoint changed.',
    'No person, no hands, and no props appear in the frame.',
  ],
  detail: [
    'The framing is tight on the specified surface, and that surface is rendered from the reference photograph rather than reimagined — the same grain, weave, wear, and markings, at a larger size.',
    'Any text, logo, or marking inside the crop is reproduced with its exact wording, letterforms, and spacing. It is never re-lettered, re-spaced, translated, or stylised.',
    'Focus falls on the specified surface and the depth of field is shallow enough that it reads as a macro photograph, without blurring the surface itself.',
  ],
  'in-use': [
    'The product itself is reproduced exactly as the reference photographs show it — same shape, same proportions, same colour, same markings, same logo wording and placement. The person and the setting are new; the product is not.',
    'The product remains the clear subject of the photograph: prominent in frame, in focus, and unobstructed. The person must not cover, crop, or overlap the branding or any defining feature.',
    'Any person in frame has correct and unremarkable anatomy — five fingers per hand, hands and limbs joined and proportioned normally, a natural grip appropriate to how this product is really held.',
    'The contact between hand and product is physically plausible: fingers wrap the surface they would actually wrap, with no part of the product passing through the body and no part of the body passing through the product.',
    'No text, captions, badges, price flashes, or graphic overlays anywhere in the image.',
    'No other branding appears in the frame — no visible logos on clothing, equipment, or surroundings.',
  ],
  scale: [
    'The product is reproduced exactly as the reference photographs show it, including its proportions relative to its own parts.',
    'Any reference object or hand in frame is at a truthful relative size, so the photograph does not misrepresent how large the product is.',
    'No text, captions, dimension labels, or graphic overlays anywhere in the image.',
  ],
  context: [
    'The product is reproduced exactly as the reference photographs show it — same shape, proportions, colour, markings, and logo. Only the surroundings are new.',
    'The product remains the clear subject: prominent, in focus, and unobstructed by the setting.',
    'No person appears in the frame.',
    'No text, captions, badges, or graphic overlays anywhere in the image.',
  ],
  packaging: [
    'Only packaging actually visible in the reference photographs is shown. No box, sleeve, tag, or insert is invented, and no printed text on packaging is invented or altered.',
    'No text, captions, badges, or graphic overlays are added to the image.',
  ],
}

/** Hard rules for a slot: its own, plus the invariants for its kind. */
export function slotHardRules(slot: Slot): string[] {
  return [...KIND_RULES[slot.kind ?? 'angle'], ...(slot.hardRules ?? [])]
}

export const LISTING_SLOTS: Slot[] = [
  {
    id: 'main',
    label: 'Main',
    mode: 'locked',
    kind: 'catalogue',
    directive:
      'The product entirely alone, centered, shot straight-on against a seamless empty background. A catalogue hero shot: nothing in frame but the product itself.',
    hardRules: [
      'The background must be pure white, RGB(255, 255, 255), edge to edge, with no gradient, vignette, shadow gradient, texture, or off-white tint.',
      'The product must fill at least 85% of the frame, and must be entirely inside the frame — never cropped or touching any edge.',
      'No props, no surfaces, no scenery, no hands, no packaging, and no other objects of any kind.',
      'No text, no labels, no badges, no captions, and no graphic overlays anywhere in the image.',
      'No watermark and no logos other than those physically present on the product itself.',
    ],
  },
  {
    id: 'angle-2',
    label: 'Angle 2',
    mode: 'creative',
    kind: 'angle',
    directive:
      'The same product rotated to a clearly different orientation from the main shot — a side view or three-quarter view that reveals a face of the product the straight-on shot could not show.',
  },
  {
    id: 'angle-3',
    label: 'Angle 3',
    mode: 'creative',
    kind: 'angle',
    directive:
      'A third distinct view: either another rotation not yet used, or a tighter shot framing one defining feature of the product.',
  },
  {
    id: 'lifestyle',
    label: 'Lifestyle',
    mode: 'creative',
    kind: 'context',
    directive:
      'The product placed in a realistic real-world setting where it would genuinely be used. Choose a setting that specifically suits this product rather than a generic backdrop. The product remains the clear subject.',
  },
  {
    id: 'detail',
    label: 'Detail',
    mode: 'creative',
    kind: 'detail',
    directive:
      'A macro close-up emphasising material, texture, finish, and craftsmanship — close enough that the surface quality is the subject of the photograph.',
  },
]

export function getSlot(id: string): Slot {
  const all = [...LISTING_SLOTS, ...PENDING_SLOTS]
  const slot = all.find((s) => s.id === id)
  if (!slot) {
    throw new Error(
      `Unknown slot "${id}". Known slots: ${all.map((s) => s.id).join(", ")}`,
    )
  }
  return slot
}

/**
 * Slots that are DESIGNED BUT NOT ACTIVE.
 *
 * Requested for fuller product coverage. Held back deliberately, because V1 measured
 * that the current pipeline cannot change the camera pose at all: `images.edit` is
 * structurally anchored to the reference photo's composition, so Angle 2 and Angle 3
 * came back as the same frontal view as Main. `input_fidelity` is already at its
 * loosest setting ('low'), so there is no tuning lever left on that endpoint.
 *
 * Activating these before that is fixed would return four more copies of Main at
 * roughly $1.38 per product in wasted generation.
 *
 * Unblock via either route, then move the entries into LISTING_SLOTS:
 *   1. A model that does novel-view synthesis (Gemini 3 Pro Image is untested here).
 *   2. Multiple source photos — `images.edit` accepts an array — which changes the
 *      spec's one-photo premise and therefore needs sign-off.
 *
 * `top` and `bottom` carry a further caveat beyond pose: those surfaces do not appear
 * in a straight-on photo at all, so the model must invent them. That conflicts with the
 * Visual DNA contract — there is nothing to preserve from — and an invented base that
 * omits a real maker's stamp is a misleading listing image, not merely a poor one.
 * Recommend sourcing real photographs for these two rather than generating them.
 */
export const PENDING_SLOTS: Slot[] = [
  {
    id: 'angle-left-45',
    label: 'Left 45°',
    mode: 'creative',
    kind: 'angle',
    directive:
      'The product rotated 45 degrees to the left of the straight-on view, so the left side wall and the front face are both visible in a true three-quarter perspective. The rim reads as an ellipse rather than a straight line, and surfaces foreshorten consistently with that rotation.',
  },
  {
    id: 'angle-right-45',
    label: 'Right 45°',
    mode: 'creative',
    kind: 'angle',
    directive:
      'The product rotated 45 degrees to the right of the straight-on view, mirroring the left three-quarter shot so the two together read as a matched pair. The rim reads as an ellipse and surfaces foreshorten consistently with that rotation.',
  },
  {
    id: 'top',
    label: 'Top',
    mode: 'creative',
    kind: 'angle',
    directive:
      'A directly overhead view looking straight down at the product, showing the upper surface and, for open vessels, the interior. Only valid when the source material actually shows these surfaces.',
  },
  {
    id: 'bottom',
    label: 'Bottom',
    mode: 'creative',
    kind: 'angle',
    directive:
      'The underside of the product, showing the base and any moulding, footring, or maker\'s marking. Only valid when the source material actually shows this surface.',
  },
]
