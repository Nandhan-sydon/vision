/**
 * Stage 1 — Visual DNA (spec §7), now derived from the whole photo set.
 *
 * A structured fingerprint of the real product, derived ONCE per product and reused for
 * every slot. Deriving it once is the point: the prompt writer and the reviewer check
 * against the same definition of the product rather than re-deriving it separately and
 * drifting apart.
 *
 * What multiple photos add is not a better description — it is a COVERAGE MAP. Alongside
 * the product's attributes, this stage records which photo shows which surface, and which
 * surfaces no photo shows at all. Everything downstream reads that map:
 *
 *   the shot plan   proposes a shot only where a photo supports it
 *   the renderer    is handed only the photos for the shot in hand
 *   the reviewer    compares the candidate against those same photos
 *
 * `absentSurfaces` is therefore load-bearing rather than informational. It is the list of
 * things the pipeline must refuse to invent, and refusing is the product: a generated
 * base that omits a real maker's stamp is a misleading listing image, not merely a weak
 * one. Never shown to the user; the coverage findings are surfaced in the seller's own
 * words by the shot plan.
 */

import { CLAUDE_MAX_TOKENS, MODELS } from '../config'
import {
  claude,
  firstText,
  labelledImageBlocks,
  parseJson,
} from './client'
import {
  photoLabel,
  toIndexes,
  validatePhotos,
  type Base64Image,
  type PhotoInput,
} from '../photos'
import { PRODUCT_CATEGORIES, type ProductCategory } from '../amazon/rules'
import type { ClaudeUsage } from '../cost'

/** What one uploaded photo contributes. Indexed to match the photo array. */
export type PhotoRole = {
  /** 0-based index into the photo array. Claude answers in 1-based labels; converted here. */
  index: number
  /** The camera position, in words: "straight-on front", "three-quarter from the left". */
  viewpoint: string
  /** Surfaces and features legible in THIS photo. */
  shows: string[]
  /** Whether this photo is good enough to derive a listing image from. */
  usable: boolean
  /** Why not, if unusable — blur, blown highlights, watermark, heavy crop. '' if fine. */
  issue: string
}

export type ImageDNA = {
  product: string
  category: string
  /**
   * Which Amazon category ruleset applies (Stage 2 spec §16).
   *
   * Assigned from the photographs rather than string-matched from `category`, because the
   * footwear rules (single shoe, facing left, 45 degrees on Main) are actively wrong for a
   * shoe rack or a shoe-shaped charm, and a wrong ruleset is worse than the default.
   */
  amazonCategory: ProductCategory
  colors: { name: string; hex: string }[]
  logo: {
    present: boolean
    text: string
    position: string
    color: string
    style: string
  }
  material: string
  finish: string
  distinguishingFeatures: string[]
  /** The specific list of things that would make this "not the same product" if altered. */
  mustNotChange: string[]

  /** Per-photo coverage. One entry per supplied photo, in order. */
  photos: PhotoRole[]
  /** Which photos show each surface. The routing table for every downstream stage. */
  visibleSurfaces: { surface: string; photos: number[] }[]
  /** Surfaces no photo shows. The refuse-to-invent list. */
  absentSurfaces: string[]
  /** Where the photos disagree — different colour cast, a mark present in one only. */
  inconsistencies: string[]
  /** How many photos this fingerprint was derived from. */
  photoCount: number
}

const SCHEMA = {
  type: 'object',
  properties: {
    product: { type: 'string', description: 'What the product is, concretely.' },
    category: { type: 'string', description: 'Broad product category.' },
    amazonCategory: {
      type: 'string',
      enum: PRODUCT_CATEGORIES,
      description:
        "Which marketplace ruleset governs this product's listing images. apparel-adult = clothing worn by adults. apparel-kids = clothing or wearables for children and babies, plus accessories and multipacks. footwear = shoes and boots. jewelry = rings, earrings, bracelets, necklaces, watches worn as jewellery. books-media = books, magazines, discs, and similar cover-art products. hardgoods = everything else, and the correct answer whenever none of the others clearly applies.",
    },
    colors: {
      type: 'array',
      description: 'Every distinct colour on the product, most prominent first.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Specific colour name, e.g. "matte charcoal".' },
          hex: {
            type: 'string',
            description: 'Best-estimate hex, e.g. "#2B2B2B". Empty string if not determinable.',
          },
        },
        required: ['name', 'hex'],
        additionalProperties: false,
      },
    },
    logo: {
      type: 'object',
      description: 'Branding physically on the product. If none, present=false and the rest empty.',
      properties: {
        present: { type: 'boolean' },
        text: { type: 'string' },
        position: { type: 'string', description: 'Where on the product it sits.' },
        color: { type: 'string' },
        style: { type: 'string', description: 'Typeface character, embossed/printed/etched, etc.' },
      },
      required: ['present', 'text', 'position', 'color', 'style'],
      additionalProperties: false,
    },
    material: { type: 'string', description: 'Wood / plastic / fabric / metal / glass / etc.' },
    finish: { type: 'string', description: 'Matte, gloss, brushed, woven, anodised, etc.' },
    distinguishingFeatures: {
      type: 'array',
      description: 'Anything unique that identifies this specific product.',
      items: { type: 'string' },
    },
    mustNotChange: {
      type: 'array',
      description:
        'The specific list of attributes that would make this a different product if altered.',
      items: { type: 'string' },
    },
    photos: {
      type: 'array',
      description:
        'One entry per supplied photo, in the order they were labelled. Never omit a photo and never invent one.',
      items: {
        type: 'object',
        properties: {
          photo: {
            type: 'integer',
            description: 'The photo number as labelled in the request. 1 for "Photo 1".',
          },
          viewpoint: {
            type: 'string',
            description:
              'Where the camera is relative to the product: "straight-on front", "three-quarter from the left", "overhead", "macro on the grip".',
          },
          shows: {
            type: 'array',
            description: 'Surfaces and features legible in THIS photo specifically.',
            items: { type: 'string' },
          },
          usable: {
            type: 'boolean',
            description:
              'True if this photo is sharp and clear enough to derive a listing image from.',
          },
          issue: {
            type: 'string',
            description:
              'Why it is not usable — blur, motion, blown highlights, watermark, heavy crop, obstruction. Empty string if there is no problem.',
          },
        },
        required: ['photo', 'viewpoint', 'shows', 'usable', 'issue'],
        additionalProperties: false,
      },
    },
    visibleSurfaces: {
      type: 'array',
      description:
        'Every distinct surface or feature of the product that at least one photo shows, and which photos show it.',
      items: {
        type: 'object',
        properties: {
          surface: {
            type: 'string',
            description: 'The surface or feature, e.g. "underside", "reverse face", "grip".',
          },
          photos: {
            type: 'array',
            description: 'The photo numbers, as labelled, in which this surface is visible.',
            items: { type: 'integer' },
          },
        },
        required: ['surface', 'photos'],
        additionalProperties: false,
      },
    },
    absentSurfaces: {
      type: 'array',
      description:
        'Surfaces a buyer of this product would reasonably want to see that NO supplied photo shows. Be specific and be honest — this list is used to refuse to generate them.',
      items: { type: 'string' },
    },
    inconsistencies: {
      type: 'array',
      description:
        'Where the photos disagree about the product: a different colour cast, a mark present in one photo and absent in another, a fitting that appears to differ. Empty array if they are consistent.',
      items: { type: 'string' },
    },
  },
  required: [
    'product',
    'category',
    'amazonCategory',
    'colors',
    'logo',
    'material',
    'finish',
    'distinguishingFeatures',
    'mustNotChange',
    'photos',
    'visibleSurfaces',
    'absentSurfaces',
    'inconsistencies',
  ],
  additionalProperties: false,
} as const

const SYSTEM = `You are cataloguing a real physical product from a set of photographs so that an image generation model can later reproduce that exact product without drift, and a reviewer can later judge whether it succeeded.

All the photographs show ONE product. They are numbered, and every photo-numbered answer you give must use the numbers as labelled in the request.

## Describe the object, not the pictures

Record only what you can actually see. Do not infer a brand, model number, or material you cannot observe — if something is genuinely unclear, describe what is visible rather than guessing at a name. Ignore each photograph's background, lighting setup, shadows, and framing when describing the product; you are describing the object, not the picture of it.

Be specific where specificity is what preserves identity. "Blue" is not useful; "muted slate blue, slightly desaturated" is. Estimate hex values from the pixels where you reasonably can. Where the photos disagree on a colour, trust the most evenly lit photo and record the disagreement.

## mustNotChange

This is the most important field. It is the list of attributes that would make a viewer say "that is not the same product" if any of them were altered — the exact logo wording and placement, a distinctive silhouette, the proportion between parts, a specific colour pairing, the count of a repeated element. Be concrete and be strict.

Multiple photographs let you be stricter than one would. An attribute confirmed from two viewpoints is worth stating flatly. An attribute you can see in only one photo, at a glancing angle, should be stated as what is actually visible rather than as a confident claim.

## The category ruleset

Assign amazonCategory from what you can see, not from a product name. It selects which
marketplace rules the listing's images are held to, and the wrong choice imposes rules that
do not fit — a footwear verdict forces the main image to show a single shoe facing left at
45 degrees, which is nonsense for a shoe rack. When more than one could arguably apply, or
when none clearly does, answer hardgoods: its rules are the universal ones and are always
safe.

## Coverage is the other half of the job

The photo set is also a statement about what is NOT known, and recording that accurately matters as much as describing the product.

For each photo, give its viewpoint and what it specifically shows. Judge usability honestly: a blurred, motion-smeared, blown-out, watermarked or heavily cropped photo should be marked unusable with the reason, even if it is the only photo of that surface.

In visibleSurfaces, list every distinct surface or feature at least one photo shows, with the photo numbers that show it. Downstream this becomes a routing table: a shot needing the underside will be rendered from the photo you say shows the underside, and from no other.

In absentSurfaces, list the surfaces a buyer would reasonably want to see that no photo shows at all — the underside of a solid object photographed only from above, the reverse of an opaque one, the inside of something closed, a fine marking that appears in no photo at a legible size. Be honest and be specific. This list is used to REFUSE to generate those surfaces and to ask the seller to photograph them instead, so under-reporting it causes invented detail to reach a live listing, and over-reporting it costs the seller a shot they already have.`

/**
 * Accepts one photo or many. A single photo still works and still produces a coverage
 * map — it simply produces a thin one, with most surfaces landing in `absentSurfaces`,
 * which is the honest answer for a one-photo upload rather than a degraded mode.
 */
export async function extractImageDNA(
  input: PhotoInput,
): Promise<{ dna: ImageDNA; usage: ClaudeUsage; ms: number }> {
  const started = Date.now()

  const check = validatePhotos(input)
  if (!check.ok) throw new Error(check.error)
  const photos: Base64Image[] = check.photos

  const response = await claude().messages.create({
    model: MODELS.claude,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: [
          ...labelledImageBlocks(photos),
          {
            type: 'text',
            text:
              `Catalogue this product. ${photos.length} photograph${photos.length === 1 ? '' : 's'} ` +
              `supplied, labelled Photo 1${photos.length > 1 ? ` to Photo ${photos.length}` : ''}. ` +
              'Return one entry in `photos` for each of them, in order.',
          },
        ],
      },
    ],
  })

  const raw = parseJson<
    Omit<ImageDNA, 'photos' | 'visibleSurfaces' | 'photoCount'> & {
      photos: { photo: number; viewpoint: string; shows: string[]; usable: boolean; issue: string }[]
      visibleSurfaces: { surface: string; photos: number[] }[]
    }
  >(firstText(response), 'Visual DNA')

  const dna = normalise(raw, photos.length)
  return { dna, usage: response.usage as ClaudeUsage, ms: Date.now() - started }
}

/**
 * Convert Claude's 1-based photo labels to array indexes, and guarantee one PhotoRole
 * per supplied photo.
 *
 * Both halves matter. Off-by-one here silently routes a shot to the wrong photo, which
 * is exactly the failure the coverage map exists to prevent, and it would look like a
 * model error rather than an indexing one. A missing entry — Claude skipping a photo it
 * found redundant — would otherwise leave a hole that reads as "no such photo".
 */
function normalise(
  raw: Omit<ImageDNA, 'photos' | 'visibleSurfaces' | 'photoCount'> & {
    photos: { photo: number; viewpoint: string; shows: string[]; usable: boolean; issue: string }[]
    visibleSurfaces: { surface: string; photos: number[] }[]
  },
  photoCount: number,
): ImageDNA {
  const byIndex = new Map<number, PhotoRole>()
  for (const entry of raw.photos ?? []) {
    const index = entry.photo - 1
    if (index < 0 || index >= photoCount) continue
    byIndex.set(index, {
      index,
      viewpoint: entry.viewpoint,
      shows: entry.shows ?? [],
      usable: entry.usable,
      issue: entry.issue ?? '',
    })
  }

  const photos: PhotoRole[] = Array.from({ length: photoCount }, (_, index) => {
    const found = byIndex.get(index)
    if (found) return found
    // Treated as usable: a photo the seller supplied and the fingerprint failed to
    // describe should not be silently dropped from rendering on the strength of an
    // omission we cannot interpret.
    return {
      index,
      viewpoint: 'not described',
      shows: [],
      usable: true,
      issue: '',
    }
  })

  const amazonCategory: ProductCategory = PRODUCT_CATEGORIES.includes(
    raw.amazonCategory as ProductCategory,
  )
    ? (raw.amazonCategory as ProductCategory)
    : 'hardgoods'

  return {
    ...raw,
    amazonCategory,
    photos,
    visibleSurfaces: (raw.visibleSurfaces ?? []).map((s) => ({
      surface: s.surface,
      photos: toIndexes(s.photos ?? [], photoCount),
    })),
    absentSurfaces: raw.absentSurfaces ?? [],
    inconsistencies: raw.inconsistencies ?? [],
    photoCount,
  }
}

/** Compact rendering of the DNA for injection into the prompt-writer's context. */
export function renderDNA(dna: ImageDNA): string {
  const colors = dna.colors
    .map((c) => (c.hex ? `${c.name} (${c.hex})` : c.name))
    .join(', ')
  const logo = dna.logo.present
    ? `"${dna.logo.text}" — ${dna.logo.position}, ${dna.logo.color}, ${dna.logo.style}`
    : 'none'

  return [
    `Product: ${dna.product}`,
    `Category: ${dna.category}`,
    `Marketplace ruleset: ${dna.amazonCategory}`,
    `Colors: ${colors}`,
    `Logo/branding: ${logo}`,
    `Material: ${dna.material}`,
    `Finish: ${dna.finish}`,
    `Distinguishing features: ${dna.distinguishingFeatures.join('; ')}`,
    `Must not change: ${dna.mustNotChange.join('; ')}`,
  ].join('\n')
}

/**
 * The coverage half of the fingerprint, rendered for the shot planner.
 *
 * Kept separate from renderDNA because the two audiences need different things: the
 * prompt writer needs the product's identity and would only be distracted by which photo
 * shows what, while the planner needs exactly that and is the stage that decides what
 * will not be generated at all.
 */
export function renderCoverage(dna: ImageDNA): string {
  const lines: string[] = [
    `${dna.photoCount} photograph${dna.photoCount === 1 ? '' : 's'} supplied.`,
    '',
  ]

  for (const photo of dna.photos) {
    const shows = photo.shows.length ? photo.shows.join('; ') : 'nothing recorded'
    const flag = photo.usable ? '' : `  [UNUSABLE: ${photo.issue || 'quality'}]`
    lines.push(`${photoLabel(photo.index)} — ${photo.viewpoint}: ${shows}${flag}`)
  }

  if (dna.visibleSurfaces.length) {
    lines.push('', 'Surface coverage:')
    for (const s of dna.visibleSurfaces) {
      const which = s.photos.length
        ? s.photos.map((i) => photoLabel(i)).join(', ')
        : 'no photo'
      lines.push(`- ${s.surface}: ${which}`)
    }
  }

  if (dna.absentSurfaces.length) {
    lines.push(
      '',
      'Shown by NO photo (must not be invented):',
      ...dna.absentSurfaces.map((s) => `- ${s}`),
    )
  }

  if (dna.inconsistencies.length) {
    lines.push(
      '',
      'The photos disagree about:',
      ...dna.inconsistencies.map((s) => `- ${s}`),
    )
  }

  return lines.join('\n')
}

/** Photos worth rendering from. A blurred or watermarked frame is not one. */
export function usablePhotoIndexes(dna: ImageDNA): number[] {
  return dna.photos.filter((p) => p.usable).map((p) => p.index)
}
