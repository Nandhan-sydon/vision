/**
 * Offline verification for the deterministic Stage 2 surfaces.
 *
 *   npx tsx scripts/verify-stage2.ts
 *
 * NO API CALLS AND NO COST. Everything checked here is deterministic by design — that is the
 * point of §7 and §12 — so it can and should be run on every change, unlike the reviewer
 * suite (~$0.32) and the render loop (real generations).
 *
 * What each group is actually protecting:
 *
 *   style grid     §7 promises the same product resolves to the same lighting and scene on
 *                  every run, forever. That promise is what makes a shot generated today
 *                  match one generated last month, and it is silently broken by anything
 *                  that makes selection order-, time- or engine-dependent. A test is the
 *                  only way to notice, because a broken build still produces good images.
 *
 *   compliance pass §12 turns probabilistic geometry into exact geometry. V1 measured the
 *                  same prompt yielding 75.3 / 90.5 / 94.5% fill; the pass must land every
 *                  one of those on the target regardless of what it was handed.
 *
 *   build memory   §7's third input. Merge and replace semantics decide whether a listing
 *                  drifts, and both are easy to get subtly wrong in a way nothing surfaces.
 *
 *   claim prefilter §13's cheap first pass. The model does the real judging, but the
 *                  never-acceptable phrases must never slip through, including when a
 *                  caller's own verdict disagrees.
 */

import 'dotenv/config'
import sharp from 'sharp'
import { resolveStyle, STYLE_GRID, LIGHTING_PALETTE, SCENE_PALETTE } from '../lib/style-grid'
import { productIdentity, productKey, stableHash } from '../lib/product-key'
import { compliancePass } from '../lib/compliance-pass'
import { checkCompliance } from '../lib/compliance'
import { emptyMemory, mergeMemory, withEntry, renderBuildMemory } from '../lib/build-memory'
import { prefilter } from '../lib/claim-check'
import { rulesFor, allowsEdgeCrop, MAIN_RULES } from '../lib/amazon/rules'
import { validatePhotos, MIN_PHOTOS } from '../lib/photos'
import type { ImageDNA } from '../lib/claude/dna'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed++
    console.log(`  OK   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function section(title: string) {
  console.log(`\n${title}`)
}

/** A minimal fingerprint. Only the fields the deterministic surfaces actually read. */
function fakeDna(over: Partial<ImageDNA> = {}): ImageDNA {
  return {
    product: 'Straight-sided ceramic coffee mug',
    category: 'drinkware',
    amazonCategory: 'hardgoods',
    colors: [{ name: 'off-white', hex: '#EFEDE7' }],
    logo: { present: true, text: 'IBM', position: 'front', color: 'blue', style: 'striped' },
    material: 'ceramic',
    finish: 'glossy',
    distinguishingFeatures: [],
    mustNotChange: [],
    photos: [],
    visibleSurfaces: [],
    absentSurfaces: [],
    inconsistencies: [],
    photoCount: 3,
    ...over,
  }
}

/** A synthetic product photo: a dark rectangle on white, at a known fill. */
async function syntheticProduct(opts: {
  canvas: number
  productPx: number
  background?: string
  offsetX?: number
  offsetY?: number
}): Promise<Buffer> {
  const { canvas, productPx } = opts
  const left = opts.offsetX ?? Math.round((canvas - productPx) / 2)
  const top = opts.offsetY ?? Math.round((canvas - productPx) / 2)

  const product = await sharp({
    create: {
      width: productPx,
      height: productPx,
      channels: 3,
      background: { r: 60, g: 70, b: 90 },
    },
  })
    .png()
    .toBuffer()

  return await sharp({
    create: {
      width: canvas,
      height: canvas,
      channels: 3,
      // Deliberately NOT pure white: every V1 output landed 4-8/255 off, so the pass has to
      // be tested on the input it will actually get.
      background: opts.background ?? { r: 250, g: 251, b: 250 },
    },
  })
    .composite([{ input: product, left, top }])
    .png()
    .toBuffer()
}

async function main() {
  // ---------------------------------------------------------------- style grid (§7)
  section('Style grid — reproducible selection')

  const dnaA = fakeDna()
  const dnaB = fakeDna({ product: 'Canvas backpack', category: 'bags', material: 'canvas' })

  const styleA1 = resolveStyle({
    kind: 'context',
    isMain: false,
    productIdentityString: productIdentity(dnaA),
    shotId: 'lifestyle',
  })
  const styleA2 = resolveStyle({
    kind: 'context',
    isMain: false,
    productIdentityString: productIdentity(dnaA),
    shotId: 'lifestyle',
  })
  const styleB = resolveStyle({
    kind: 'context',
    isMain: false,
    productIdentityString: productIdentity(dnaB),
    shotId: 'lifestyle',
  })

  check(
    'same product + same shot resolves to the same lighting and scene',
    styleA1.lighting.id === styleA2.lighting.id && styleA1.scene?.id === styleA2.scene?.id,
  )
  check(
    'lighting is stable across every shot of one product',
    resolveStyle({
      kind: 'detail',
      isMain: false,
      productIdentityString: productIdentity(dnaA),
      shotId: 'macro',
    }).lighting.id === styleA1.lighting.id,
  )
  check(
    'selection is drawn only from the bounded palettes',
    LIGHTING_PALETTE.some((l) => l.id === styleA1.lighting.id) &&
      SCENE_PALETTE.some((s) => s.id === styleA1.scene?.id),
  )
  check(
    'a different product does not inherit the same scene',
    styleB.scene?.id !== styleA1.scene?.id || styleB.lighting.id !== styleA1.lighting.id,
    `A=${styleA1.lighting.id}/${styleA1.scene?.id} B=${styleB.lighting.id}/${styleB.scene?.id}`,
  )
  check(
    'the same product re-fingerprinted from other photos keeps its key',
    productKey(fakeDna({ photoCount: 6, photos: [] })) === productKey(dnaA),
  )
  check('hash is engine-independent (FNV-1a fixed vector)', stableHash('abc') === 440920331,
    `got ${stableHash('abc')}`)

  section('Style grid — Main carries no styling freedom')
  const mainStyle = resolveStyle({
    kind: 'catalogue',
    isMain: true,
    productIdentityString: productIdentity(dnaA),
    shotId: 'main',
  })
  check('Main is shadow-free', mainStyle.shadow === 'none')
  check('Main has no scene', mainStyle.scene === undefined)
  check(
    'Main directives state pure white, the fill target, and no shadow',
    mainStyle.directives.some((d) => d.includes('#FFFFFF')) &&
      mainStyle.directives.some((d) => d.includes(`${STYLE_GRID.main.targetFillPct}%`)) &&
      mainStyle.directives.some((d) => d.toLowerCase().includes('shadow: none')),
  )
  const secondaryStyle = resolveStyle({
    kind: 'context',
    isMain: false,
    productIdentityString: productIdentity(dnaA),
    shotId: 'scene',
  })
  check(
    'secondary states the one fixed contact shadow numerically',
    secondaryStyle.directives.some(
      (d) =>
        d.includes(`${STYLE_GRID.secondaryShadow.blurRadiusPx}px`) &&
        d.includes(`${Math.round(STYLE_GRID.secondaryShadow.opacity * 100)}%`),
    ),
  )

  // ------------------------------------------------------- compliance pass (§10, §12)
  section('Compliance pass — fill is forced to target regardless of input')

  for (const [label, productPx] of [
    ['under-filled (~40%)', 400],
    ['well-filled (~75%)', 750],
    ['over-filled (~96%)', 960],
  ] as const) {
    const input = await syntheticProduct({ canvas: 1000, productPx })
    const before = await checkCompliance(input)
    const result = await compliancePass(input, { isMain: true })
    check(
      `${label}: ${before.fillLinearPct}% -> ${result.report?.fillLinearPct}% (target ${STYLE_GRID.main.targetFillPct}%)`,
      Math.abs((result.report?.fillLinearPct ?? 0) - STYLE_GRID.main.targetFillPct) <= 2,
    )
    check(`${label}: released`, result.released, result.notes.join(' '))
  }

  section('Compliance pass — §10 output targets')
  const sample = await syntheticProduct({ canvas: 1024, productPx: 700 })
  const out = await compliancePass(sample, { isMain: true })
  check(`square ${STYLE_GRID.output.targetEdgePx}px`, out.width === 2000 && out.height === 2000,
    `${out.width}x${out.height}`)
  check('JPEG', out.mimeType === 'image/jpeg')
  check('under the 10MB ceiling', out.bytes <= STYLE_GRID.output.maxFileBytes,
    `${(out.bytes / 1024 / 1024).toFixed(2)}MB`)
  check('sRGB tagged', (await sharp(out.buffer).metadata()).space === 'srgb')
  check(
    'background is exactly RGB(255,255,255) across the field',
    out.report?.bgMaxDeviationExcludingEdge === 0,
    `${out.report?.bgMaxDeviationExcludingEdge}/255 off across the field`,
  )
  // Recorded rather than asserted. A hard-edged synthetic is the worst case for JPEG ringing,
  // and the number is the format's, not the pipeline's — asserting zero here would be
  // asserting that JPEG does not ring.
  console.log(
    `       (edge ring: ${out.report?.bgMaxDeviation}/255 within 8px of the outline, ` +
      `${out.report?.bgPureWhitePct}% of background pixels exactly 255)`,
  )
  check('product does not touch the frame edge', out.report?.touchesEdge === false)

  section('Compliance pass — a product touching the edge is rescued, not shipped broken')
  const bleeding = await syntheticProduct({
    canvas: 1000,
    productPx: 1000,
    offsetX: 0,
    offsetY: 0,
  })
  const rescued = await compliancePass(bleeding, { isMain: true })
  check(
    'padded away from the edge',
    rescued.report?.touchesEdge === false,
    'the pass crops to bounds and pads, so a bled product becomes compliant',
  )

  section('Compliance pass — secondary keeps its scene')
  const scene = await syntheticProduct({ canvas: 1024, productPx: 500, background: '#8899aa' })
  const secondary = await compliancePass(scene, { isMain: false })
  check('released', secondary.released, secondary.notes.join(' '))
  check('resized to target', secondary.width === 2000 && secondary.height === 2000)
  check('no white composite applied', secondary.report === undefined)
  check(
    'platform grade recorded',
    secondary.actions.some((a) => a.includes('platform grade')),
  )

  // ------------------------------------------------------------- amazon rules (§14-§17)
  section('Amazon rules')
  const mainRules = rulesFor({ category: 'hardgoods', isMain: true })
  const secondaryRules = rulesFor({ category: 'hardgoods', isMain: false })
  check('Main carries every §14 rule', MAIN_RULES.every((r) => mainRules.includes(r)))
  check(
    'secondary does NOT demand a white background',
    !secondaryRules.some((r) => r.includes('RGB(255, 255, 255)')),
  )
  check(
    'the honesty floor applies in both positions',
    mainRules.some((r) => r.includes('not shown in an uploaded photograph')) &&
      secondaryRules.some((r) => r.includes('not shown in an uploaded photograph')),
  )
  check(
    'footwear forces a single shoe on Main',
    rulesFor({ category: 'footwear', isMain: true }).some((r) => r.includes('SINGLE shoe')),
  )
  check(
    'kids apparel bans underwear/swimwear on a child in EVERY position',
    rulesFor({ category: 'apparel-kids', isMain: false }).some((r) =>
      r.includes('underwear, swimwear'),
    ),
  )
  check(
    'necklace exception applies only to necklaces',
    allowsEdgeCrop({ category: 'jewelry', product: 'Silver pendant necklace' }) &&
      !allowsEdgeCrop({ category: 'jewelry', product: 'Silver bangle bracelet' }) &&
      !allowsEdgeCrop({ category: 'hardgoods', product: 'necklace holder' }),
  )

  // ------------------------------------------------------------------ build memory (§7)
  section('Build memory')
  const base = emptyMemory('mug-abc')
  const entry = {
    shotId: 'lifestyle',
    shotLabel: 'Lifestyle',
    kind: 'context' as const,
    lightingId: 'soft-window-left',
    sceneId: 'pale-wood-domestic',
    shadow: 'contact',
    passed: true,
    promptExcerpt: 'a mug on oak',
    at: '2026-08-20T10:00:00.000Z',
  }
  const one = withEntry(base, entry)
  const regenerated = withEntry(one, { ...entry, lightingId: 'overhead-diffused', at: '2026-08-20T11:00:00.000Z' })
  check('regenerating a shot replaces its entry rather than appending', regenerated.entries.length === 1)
  check('the replacement is the newer one', regenerated.entries[0].lightingId === 'overhead-diffused')

  const merged = mergeMemory(one, withEntry(base, { ...entry, shotId: 'detail', at: '2026-08-20T09:00:00.000Z' }))
  check('merge keeps entries from both sides', merged.entries.length === 2)
  check(
    'a later entry wins over a stale one',
    mergeMemory(regenerated, one).entries[0].lightingId === 'overhead-diffused',
  )
  check(
    'the current shot is excluded from its own memory',
    !renderBuildMemory(one, 'lifestyle').includes('soft-window-left'),
  )
  check(
    'other shots are included, with their style',
    renderBuildMemory(one, 'detail').includes('soft-window-left'),
  )

  // --------------------------------------------------------------- claim prefilter (§13)
  section('Claim-language prefilter')
  check('catches a platform badge', prefilter("Amazon's Choice for yoga mats").length > 0)
  check('catches an unsubstantiated proof claim', prefilter('Clinically proven formula').length > 0)
  check('catches a shipping promise', prefilter('FREE SHIPPING on all orders').length > 0)
  check('is case-insensitive', prefilter('fda approved').length > 0)
  check('leaves permitted structure/function language alone', prefilter('Supports healthy posture').length === 0)
  check('leaves plain description alone', prefilter('6mm cushioned yoga mat').length === 0)

  // ----------------------------------------------------------------- photo floor (§2)
  section('Photo floor')
  const photo = { data: 'x', mediaType: 'image/jpeg' }
  check('one photo is rejected', validatePhotos([photo]).ok === false)
  check(`${MIN_PHOTOS} photos are accepted`, validatePhotos([photo, photo]).ok === true)
  check('nine photos are rejected', validatePhotos(Array(9).fill(photo)).ok === false)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
