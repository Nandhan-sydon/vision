/**
 * A stable identity for one product, derived from its fingerprint.
 *
 * Two stages need to agree on "this is the same product as last time", and neither can rely
 * on a database id because the pipeline is stateless per request:
 *
 *   style grid     picks this product's lighting and scene family deterministically, so a
 *                  shot generated today matches one generated last week (§7)
 *   build memory   keys the record of what has already been generated (§7)
 *
 * Derived from the attributes that make the product *that* product rather than from the
 * photo bytes. Re-uploading the same item from different photographs must land on the same
 * key, or every re-run re-rolls the scene and the catalogue drifts — which is precisely the
 * failure §7 exists to prevent. Conversely two genuinely different products must not
 * collide, or one would inherit the other's lifestyle scene, which §18 forbids outright.
 */

import type { ImageDNA } from './claude/dna'

/**
 * FNV-1a, 32-bit.
 *
 * Not for security — for a stable, dependency-free integer that is identical across
 * machines and Node versions. `Math.random()` would re-roll per run and a JS string hash
 * varies by engine; neither is acceptable for a value that has to reproduce a year later.
 */
export function stableHash(input: string): number {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * The product's identity string.
 *
 * Deliberately excludes anything that varies between photo sets of the same item —
 * viewpoints, coverage, photo count, framing. Includes the logo text and the primary
 * colours because a red variant and a blue variant of one design are, for listing
 * purposes and under §16, different products with different Main images.
 */
export function productIdentity(dna: ImageDNA): string {
  const colors = dna.colors
    .slice(0, 3)
    .map((c) => `${c.name}${c.hex}`)
    .join('|')
  return [
    dna.product.trim().toLowerCase(),
    dna.category.trim().toLowerCase(),
    dna.material.trim().toLowerCase(),
    dna.logo.present ? dna.logo.text.trim().toLowerCase() : 'nologo',
    colors.toLowerCase(),
  ].join('::')
}

/** Filesystem- and URL-safe key for this product. */
export function productKey(dna: ImageDNA): string {
  const slug = dna.product
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return `${slug || 'product'}-${stableHash(productIdentity(dna)).toString(36)}`
}
