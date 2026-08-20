/**
 * Amazon's listing-image ruleset, as data — Stage 2 spec §14-§17.
 *
 * Rules live here and nowhere else. They are consumed by three stages that must agree
 * exactly, because a rule enforced in one and not the others is worse than no rule:
 *
 *   prompt writer   folds the applicable rules into every prompt as hard constraints (§8)
 *   reviewer        checks the produced image against those same rules (§11)
 *   compliance pass verifies the released file against them a final time (§12)
 *
 * Phrased as instructions to a generator rather than as policy prose, because that is the
 * form the prompt writer needs and paraphrasing at the call site is where drift starts.
 *
 * Nothing here is advisory. §18 forbids shipping a Main image outside §14, and forbids any
 * override or bypass path, so every list below is a gate.
 */

/**
 * §16. The category decides which extra Main-image rules apply.
 *
 * Assigned by the fingerprint stage from the photos rather than string-matched from a
 * category name: "shoe" in a product title could be footwear, a shoe rack, or a charm, and
 * the footwear rules (single shoe, facing left, 45°) would be actively wrong on the latter
 * two. 'hardgoods' is the documented default when nothing else applies.
 */
export type ProductCategory =
  /** Adult clothing. On-model standing, or ghost-mannequin. */
  | 'apparel-adult'
  /** Kids, baby, accessories, multipacks. Off-model flat lay. */
  | 'apparel-kids'
  | 'footwear'
  | 'jewelry'
  | 'books-media'
  /** Default. Universal rules only. */
  | 'hardgoods'

export const PRODUCT_CATEGORIES: ProductCategory[] = [
  'apparel-adult',
  'apparel-kids',
  'footwear',
  'jewelry',
  'books-media',
  'hardgoods',
]

/**
 * §14. Main-image rules that apply in every category.
 *
 * The background and fill rules are stated here for the prompt AND enforced numerically by
 * the compliance pass. That duplication is intentional: V1 measured that no generator
 * outputs mathematically flat white however firmly it is asked, so the prompt's job is to
 * get close and keep props out, and the pass's job is to make the numbers exact.
 */
export const MAIN_RULES: string[] = [
  'The background is pure white, RGB(255, 255, 255), edge to edge, with no gradient, vignette, texture, tint, or off-white cast. Near-white is rejected.',
  'The product fills at least 85% of the frame. There is no upper bound.',
  'The entire product is inside the frame. No part of it is cropped or touches any edge.',
  'No text, wording, or numerals appear anywhere in the image.',
  'No logo, brand mark, or watermark appears other than those physically printed on the product itself.',
  'No badge, seal, ribbon, certification mark, award, or star rating appears — real, implied, or fabricated.',
  'No border, frame, matte, inset panel, or coloured edge treatment of any kind.',
  'No props, accessories, surfaces, scenery, or packaging that are not included in the sale.',
  'Exactly one product, from exactly one viewpoint. No second copy of the product, no multi-angle collage.',
  'No shadow touches or crosses the frame edge. The product sits on seamless white with no cast shadow.',
  'No before-and-after or comparison imagery.',
  'If a person appears, they are standing. Never seated, kneeling, leaning, or lying down.',
  'No visible mannequin.',
]

/** §15. Positions 2-9. Far looser, and the prohibitions that survive are the honesty ones. */
export const SECONDARY_RULES: string[] = [
  'A white background is not required. Lifestyle scenes, coloured backgrounds, and staged context are permitted.',
  'Text overlays, callouts, comparison charts, and scale references are permitted, and together must not cover more than about 20% of the image area.',
  'No fabricated badge, certification, award, seal, or star rating — real, implied, or fabricated.',
  'No third-party guarantee or platform-programme language: no "Prime", no "Amazon\'s Choice", no "Best Seller", no "free shipping", no warranty promise, unless it is accurate and verified.',
  'Nothing in the frame misrepresents what the buyer actually receives. An item not included in the sale is not shown as though it were.',
]

/** §17. Never in any image, in any position. The honesty floor, and it is absolute. */
export const PROHIBITED_ANY: string[] = [
  'No nudity and no sexually suggestive content.',
  'A new-condition product is never presented as used, damaged, or second-hand.',
  'No claim, written or visually implied, that cannot be substantiated.',
  'No health, safety, outcome, or disease-related claim of any kind.',
  'No fabricated certification, award, or programme badge.',
  'No visual misrepresentation of what the buyer receives.',
  'No product surface, feature, colour, or variant that is not shown in an uploaded photograph. An unphotographed surface is never depicted.',
  'The product\'s colour, material, proportions, scale, and content set are never altered from the source photographs.',
]

/** §16 + §17. Extra rules by category, on top of the universal ones. */
export const CATEGORY_RULES: Record<
  ProductCategory,
  { main: string[]; secondary: string[]; note: string }
> = {
  'apparel-adult': {
    main: [
      'The garment is shown either on a live model in a standing pose, or using the ghost-mannequin technique — the garment holding its worn shape with no mannequin visible inside it.',
      'Where a model is used, visible hair falls behind the shoulder and does not cross the garment.',
    ],
    secondary: [],
    note: 'Adult clothing: on-model standing, or ghost mannequin, on Main.',
  },
  'apparel-kids': {
    main: [
      'The item is shown off-model as a flat lay. No child, baby, or mannequin appears.',
      'A child or baby is never shown wearing underwear, swimwear, or a leotard-type product, in any image.',
    ],
    secondary: [
      'A child or baby is never shown wearing underwear, swimwear, or a leotard-type product, in any image.',
    ],
    note: 'Kids, baby, accessories, multipacks: off-model flat lay on Main.',
  },
  footwear: {
    main: [
      'The Main image shows a SINGLE shoe, not the pair.',
      'The shoe faces left and is turned to a 45-degree angle from the camera, on plain white.',
    ],
    secondary: [
      'The full pair, and any worn or lifestyle shot, belong here rather than on the Main image.',
    ],
    note: 'Footwear: one shoe, facing left, 45°, on Main. Pair and worn shots are secondary.',
  },
  jewelry: {
    main: [
      'The full product is visible inside the frame for rings, earrings, bracelets, and watches.',
      'A necklace — and only a necklace — may crop at the frame edge.',
      'No packaging or props unless the box is an explicit, stated part of the sale.',
    ],
    secondary: [],
    note: 'Jewelry: full product in frame; necklaces may crop. Each metal or gemstone variant needs its own Main image.',
  },
  'books-media': {
    main: ['The cover art may fill the entire frame, edge to edge.'],
    secondary: [],
    note: 'Books and media: cover art may fill the frame.',
  },
  hardgoods: {
    main: [],
    secondary: [],
    note: 'Generic hardgoods: universal Main and secondary rules apply directly.',
  },
}

/**
 * The complete rule set for one shot.
 *
 * `isMain` rather than a shot-kind check, because Main is a compliance slot and the only
 * position §14 governs. Everything else is a secondary position under §15, however
 * catalogue-like it looks.
 */
export function rulesFor(args: {
  category: ProductCategory
  isMain: boolean
}): string[] {
  const category = CATEGORY_RULES[args.category] ?? CATEGORY_RULES.hardgoods
  return args.isMain
    ? [...MAIN_RULES, ...category.main, ...PROHIBITED_ANY]
    : [...SECONDARY_RULES, ...category.secondary, ...PROHIBITED_ANY]
}

/** Human-readable note for the run report and the seller-facing UI. */
export function categoryNote(category: ProductCategory): string {
  return (CATEGORY_RULES[category] ?? CATEGORY_RULES.hardgoods).note
}

/**
 * §16, jewelry. The one place a product legitimately crops at the frame edge, so the
 * compliance pass needs to know rather than treating it as the hard fail it is everywhere
 * else. Kept as a predicate on the fingerprint text because "necklace" is the exception's
 * actual scope — a bracelet in the jewelry category does not get it.
 */
export function allowsEdgeCrop(args: {
  category: ProductCategory
  product: string
}): boolean {
  return (
    args.category === 'jewelry' &&
    /\b(necklace|pendant|chain|choker)\b/i.test(args.product)
  )
}
