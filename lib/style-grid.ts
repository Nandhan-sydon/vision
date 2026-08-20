/**
 * The platform style grid — Stage 2 spec §7.
 *
 * Every styling decision left open to the generator produces two failures at once: visible
 * drift across one seller's catalogue, and near-identical output across unrelated products.
 * Both come from the same cause — an undirected prompt — and neither is fixable by asking
 * the model to be more consistent, because the model has no memory of the other images.
 *
 * So the decision is removed from the model. This file holds the fixed values; the prompt
 * writer is handed the ones relevant to the shot, and the compliance pass applies the rest
 * deterministically. Nothing here is a suggestion and nothing here is per-product.
 *
 * ## The three inputs, always in this order (§7)
 *
 *   1. Image DNA        what makes this product *this* product
 *   2. this style grid  what makes every image on the platform belong together
 *   3. build memory     what has already been generated for this product, so new shots
 *                       match the ones already shipped
 *
 * Identity and coherence are carried by two separate inputs on purpose. The DNA cannot
 * carry coherence — it describes one product and knows nothing of the platform. The grid
 * cannot carry identity — it is identical for everyone. Collapsing them into one "style
 * prompt" loses whichever the wording happens to favour.
 *
 * ## Why selection is hashed rather than chosen
 *
 * Lighting and scene are picked from bounded palettes by hashing the product's identity.
 * That is what makes the choice reproducible: the same product resolves to the same setup
 * on every run, in any process, a year apart — which is the actual requirement behind
 * "new shots match old ones". A model asked to pick would pick differently each time, and
 * a random pick would too. It also spreads unrelated products across the palette, which is
 * what stops one product's lifestyle scene being re-skinned for another (§18).
 */

import type { ShotKind } from './slots'
import { stableHash } from './product-key'

/** §7, §10, §12. Fixed geometry and colour targets. Applied by the compliance pass. */
export const STYLE_GRID = {
  main: {
    /** §14. Exact, not near. */
    background: '#FFFFFF',
    /**
     * §14 requires ≥85% with no upper bound; the grid pins a single target so margin logic
     * is identical on every run. 88 sits clear of the floor after JPEG edge softening
     * without cropping tight enough to look airless.
     */
    targetFillPct: 88,
    minFillPct: 85,
    /** §7, §14. Main is shadow-free; no shadow may touch or cross the frame edge. */
    shadow: 'none',
    centred: true,
  },

  /**
   * §7. ONE contact-shadow style for every secondary and lifestyle image, everywhere.
   *
   * Stated numerically because "a soft natural shadow" is exactly the undirected decision
   * that drifts. These values are given to the prompt writer verbatim so the generator
   * aims at them, and they are what a reviewer compares against.
   */
  secondaryShadow: {
    description:
      'a single soft contact shadow directly beneath the product where it meets the surface',
    blurRadiusPx: 24,
    opacity: 0.22,
    /** Directly below: no directional cast, so the style does not depend on scene layout. */
    offsetPx: 0,
    spreadPct: 6,
  },

  /** §7. Same crop ratio and upscale approach for every detail shot, every product. */
  detail: {
    aspectRatio: '1:1',
    /** Fraction of the source frame's shorter edge the macro crop spans. */
    cropFraction: 0.45,
    /** §10. Every image lands here regardless of the generator's native size. */
    upscaleToPx: 2000,
  },

  /** §10. Applies to every released file. */
  output: {
    aspectRatio: '1:1',
    minEdgePx: 1000,
    targetEdgePx: 2000,
    maxEdgePx: 10000,
    format: 'jpeg' as const,
    colorProfile: 'sRGB' as const,
    maxFileBytes: 10 * 1024 * 1024,
    /** Starting quality; the pass steps down if the file exceeds maxFileBytes. */
    jpegQuality: 92,
  },

  /**
   * §7. Colour grading, applied at the compliance pass with one identical target.
   *
   * Deliberately gentle. The grade exists to pull every image onto one neutral, slightly
   * bright baseline so a catalogue reads as one shoot; it is not a look. Anything stronger
   * would start altering the product's colour, which §17 prohibits outright.
   */
  grading: {
    saturation: 1.02,
    brightness: 1.01,
    /** Applied to secondary images only — Main is composited on flat white already. */
    appliesTo: 'secondary' as const,
  },

  /** §7. Fixed infographic template. Only text content and icon choice vary per product. */
  infographic: {
    canvasPx: 2000,
    /** §15. Overlay coverage stays under the ~20% ceiling. */
    maxOverlayAreaPct: 20,
    calloutPositions: ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const,
    fontFamily: 'Inter, "Helvetica Neue", Arial, sans-serif',
    headingSizePx: 64,
    bodySizePx: 40,
    lineWeight: 3,
    textColor: '#141414',
    panelColor: '#FFFFFF',
    panelOpacity: 0.88,
    accentColor: '#1A6DFF',
    maxCallouts: 4,
    /** Characters. Longer copy shrinks the panel below legibility at thumbnail size. */
    maxCalloutChars: 72,
  },
} as const

/**
 * §7. The bounded lighting palette. A prompt never invents a lighting setup.
 *
 * Six entries, all studio-plausible and all neutral enough not to tint the product. The
 * palette is small on purpose: its job is coherence, and a palette wide enough to always
 * feel fresh is a palette wide enough to drift.
 */
export type LightingSetup = { id: string; prompt: string }

export const LIGHTING_PALETTE: LightingSetup[] = [
  {
    id: 'soft-window-left',
    prompt:
      'soft daylight from a large window to the left, gentle falloff to the right, no hard highlights',
  },
  {
    id: 'overhead-diffused',
    prompt:
      'even diffused overhead light as from a large softbox directly above, minimal directional shading',
  },
  {
    id: 'window-behind-45',
    prompt:
      'soft daylight from behind and to the right at roughly 45 degrees, giving a clean rim along the top edge without blowing it out',
  },
  {
    id: 'warm-late-afternoon',
    prompt:
      'warm low-angle late-afternoon daylight from the left, long gentle gradients, no colour cast on the product itself',
  },
  {
    id: 'bright-neutral-studio',
    prompt:
      'bright neutral studio lighting, two large diffused sources at equal intensity either side, shadowless on the product',
  },
  {
    id: 'soft-top-front',
    prompt:
      'soft light from above and slightly in front, a clean single soft shadow directly beneath the product',
  },
]

/**
 * §7. The bounded scene palette for context and in-use shots.
 *
 * A *family* rather than a full scene: the family fixes the register and the surfaces, and
 * the shot's own directive supplies what the product is doing. That split is what lets two
 * lifestyle shots of one product differ from each other while still reading as one shoot.
 */
export type SceneFamily = { id: string; prompt: string }

export const SCENE_PALETTE: SceneFamily[] = [
  {
    id: 'pale-wood-domestic',
    prompt:
      'a pale oak surface in a bright, uncluttered domestic interior, plain off-white wall well out of focus behind',
  },
  {
    id: 'neutral-stone-worktop',
    prompt:
      'a honed light-grey stone worktop, minimal modern interior, soft neutral background falling away out of focus',
  },
  {
    id: 'warm-linen-tabletop',
    prompt:
      'a warm natural linen surface on a plain tabletop, calm and uncluttered, muted neutral background',
  },
  {
    id: 'matte-concrete-studio',
    prompt:
      'a matte pale concrete surface, spare contemporary studio setting, plain mid-grey background out of focus',
  },
  {
    id: 'outdoor-open-shade',
    prompt:
      'outdoors in open shade against a plain natural background of foliage or sky, well out of focus, no landmarks or signage',
  },
  {
    id: 'neutral-seamless-mid',
    prompt:
      'a seamless mid-tone neutral studio backdrop with a subtle floor-to-wall curve, no props beyond the product',
  },
]

/**
 * The style values that apply to one shot, resolved deterministically.
 *
 * `productIdentityString` is the product's stable identity (see lib/product-key.ts). The
 * shot id is folded in for scene selection only, so a product's two lifestyle shots differ
 * from each other while sharing a family — coherent, not identical.
 */
export type ResolvedStyle = {
  lighting: LightingSetup
  scene?: SceneFamily
  shadow: string
  background?: string
  framing?: string
  cropRule?: string
  /** Every line the prompt writer must fold in for this shot. */
  directives: string[]
}

export function resolveStyle(args: {
  kind: ShotKind
  isMain: boolean
  productIdentityString: string
  shotId: string
}): ResolvedStyle {
  const { kind, isMain, productIdentityString, shotId } = args

  // Lighting is keyed on the product alone: every shot of one product shares a setup, which
  // is what makes a listing read as one session rather than six.
  const lighting =
    LIGHTING_PALETTE[stableHash(productIdentityString) % LIGHTING_PALETTE.length]

  const wantsScene = kind === 'in-use' || kind === 'context' || kind === 'scale'
  const scene = wantsScene
    ? SCENE_PALETTE[
        stableHash(`${productIdentityString}::${shotId}`) % SCENE_PALETTE.length
      ]
    : undefined

  const directives: string[] = []

  if (isMain) {
    directives.push(
      `Background: pure white ${STYLE_GRID.main.background}, edge to edge, seamless, with no gradient, vignette, texture, or tint.`,
      `Framing: the product centred in the frame, filling approximately ${STYLE_GRID.main.targetFillPct}% of it, entirely inside the frame and touching no edge.`,
      'Shadow: none. The product sits on seamless white with no cast or contact shadow of any kind, and nothing resembling a shadow reaches the frame edge.',
    )
  } else {
    const s = STYLE_GRID.secondaryShadow
    directives.push(
      `Shadow: exactly one shadow — ${s.description} — soft-edged with roughly a ${s.blurRadiusPx}px blur at 2000px, about ${Math.round(s.opacity * 100)}% opacity, sitting directly beneath the product with no directional offset. No second shadow, no dramatic cast shadow.`,
    )
  }

  directives.push(`Lighting: ${lighting.prompt}.`)

  if (scene) {
    directives.push(
      `Setting: ${scene.prompt}. Keep it spare — the product is the subject and the setting stays subordinate to it.`,
    )
  }

  if (kind === 'detail') {
    directives.push(
      `Crop: a square ${STYLE_GRID.detail.aspectRatio} macro spanning roughly ${Math.round(
        STYLE_GRID.detail.cropFraction * 100,
      )}% of the product's shorter dimension, the specified surface filling the frame and sharply in focus.`,
    )
  }

  directives.push(
    `Output: square ${STYLE_GRID.output.aspectRatio}, photographic, colour-neutral with no stylised grade, filter, or vignette.`,
  )

  return {
    lighting,
    scene,
    shadow: isMain ? 'none' : STYLE_GRID.secondaryShadow.description,
    background: isMain ? STYLE_GRID.main.background : scene?.prompt,
    framing: isMain
      ? `centred, ${STYLE_GRID.main.targetFillPct}% fill`
      : undefined,
    cropRule: kind === 'detail' ? STYLE_GRID.detail.aspectRatio : undefined,
    directives,
  }
}

/** One line for the run report and build memory. */
export function describeStyle(style: ResolvedStyle): string {
  return [
    `lighting=${style.lighting.id}`,
    style.scene ? `scene=${style.scene.id}` : null,
    `shadow=${style.shadow === 'none' ? 'none' : 'fixed-contact'}`,
  ]
    .filter(Boolean)
    .join(' · ')
}
