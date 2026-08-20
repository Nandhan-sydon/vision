/**
 * Does the reviewer actually discriminate?
 *
 *   npx tsx scripts/verify-review.ts [slug]
 *
 * A reviewer that is never contradicted looks like it works. This one now gates what
 * reaches a live listing, so before trusting a verdict it has to be shown cases where the
 * right answer is known in advance, including cases it should REJECT. A reviewer that
 * passes everything and a reviewer that works are indistinguishable from a run where
 * everything happened to be fine.
 *
 * Four cases, each with a known answer, none of which generates an image — the whole
 * suite is Claude vision calls against photos already on disk, so it costs cents and can
 * be run on every change to the review prompt:
 *
 *   1. control        a real macro crop of the seller's own photo, reviewed as a detail
 *                     shot. This is exactly what a correct detail render looks like: 100%
 *                     real pixels of the real surface, at the framing the shot asked for.
 *                     → expect PASS. Catches a reviewer that rejects everything, which
 *                       would burn the retry budget on every shot.
 *
 *                     Handing back the whole reference frame instead does NOT work as a
 *                     control, and the first version of this script did exactly that: for
 *                     an 'angle' shot the reference frame is a duplicate-view failure, and
 *                     the reviewer was right to reject it. A control has to be an image
 *                     that genuinely satisfies the brief it is reviewed against.
 *
 *   2. wrong product  a different product entirely as the candidate.
 *                     → expect RETRY or REJECT, identity low, an identity-drift defect.
 *                       This is the failure the whole stage exists to catch.
 *
 *   3. recoloured     the real product with its hue rotated.
 *                     → expect a rejection. The subtle case, and the realistic one: shape,
 *                       markings and framing are all perfect and the colour is wrong. A
 *                       reviewer that passes this passes identity drift generally.
 *
 *   4. rule violation the real product composited onto a coloured background, reviewed
 *                     against the compliance-locked Main slot.
 *                     → expect a rejection on the hard rules rather than on likeness.
 *
 * Case 3 is the one that matters most. Cases 1 and 2 are easy for any reviewer; a model
 * asked "is this the same product" answers them from a glance. Case 3 requires it to
 * actually compare, which is what the review prompt spends most of its length demanding.
 */

import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { extractImageDNA, type ImageDNA } from '../lib/claude/dna'
import { checkCompliance, type ComplianceReport } from '../lib/compliance'
import { snapWhitePoint } from '../lib/postprocess'
import { reviewImage, type Review } from '../lib/claude/review'
import { getSlot, type Slot } from '../lib/slots'
import { claudeCostUsd, usd } from '../lib/cost'
import { validateEnv } from '../lib/config'
import type { Base64Image } from '../lib/photos'

const MEDIA: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

async function load(file: string): Promise<Base64Image> {
  const buf = await readFile(path.resolve(file))
  const mediaType = MEDIA[path.extname(file).toLowerCase()]
  if (!mediaType) throw new Error(`Unsupported extension for ${file}`)
  return { data: buf.toString('base64'), mediaType }
}

/**
 * A real macro crop of the real photo — what a correct detail shot is made of.
 *
 * Supplied to the fingerprint as a photo in its own right, AND used as the control
 * candidate. That is not circular: it is the definition of a perfect detail render, which
 * routes to the photo showing the surface and reproduces it. If the reviewer will not pass
 * the real pixels of a covered surface, it will not pass any detail shot.
 */
async function macroCrop(file: string): Promise<Base64Image> {
  const src = sharp(path.resolve(file))
  const meta = await src.metadata()
  const w = meta.width ?? 1000
  const h = meta.height ?? 1000
  const buf = await src
    .extract({
      left: Math.round(w * 0.14),
      top: Math.round(h * 0.26),
      width: Math.round(w * 0.72),
      height: Math.round(h * 0.4),
    })
    .png()
    .toBuffer()
  return { data: buf.toString('base64'), mediaType: 'image/png' }
}

/** Hue-rotate the real product. Same object, same framing, wrong colour. */
async function recolour(file: string): Promise<Base64Image> {
  const buf = await sharp(path.resolve(file)).modulate({ hue: 140 }).png().toBuffer()
  return { data: buf.toString('base64'), mediaType: 'image/png' }
}

/** Composite the real product onto a coloured field — a Main-slot hard-rule violation. */
async function colouredBackground(file: string): Promise<Base64Image> {
  const src = sharp(path.resolve(file))
  const meta = await src.metadata()
  const buf = await sharp({
    create: {
      width: meta.width ?? 1024,
      height: meta.height ?? 1024,
      channels: 3,
      background: '#c81e2d',
    },
  })
    .composite([
      {
        input: await src
          .clone()
          .resize(Math.round((meta.width ?? 1024) * 0.7), null, { fit: 'inside' })
          .toBuffer(),
        gravity: 'center',
      },
    ])
    .png()
    .toBuffer()
  return { data: buf.toString('base64'), mediaType: 'image/png' }
}

type Case = {
  name: string
  candidate: Base64Image
  slot: Slot
  /** What a working reviewer must say. */
  expect: 'pass' | 'reject'
  /** Why this case exists, printed alongside the result. */
  why: string
}

function verdictMatches(review: Review, expected: 'pass' | 'reject'): boolean {
  return expected === 'pass' ? review.verdict === 'pass' : review.verdict !== 'pass'
}

function describe(review: Review): string {
  const s = review.scores
  return (
    `${review.verdict.toUpperCase().padEnd(6)} ` +
    `identity ${String(s.identity).padStart(3)} · brief ${String(s.brief).padStart(3)} · ` +
    `realism ${String(s.realism).padStart(3)} · strategy ${review.retryStrategy}`
  )
}

async function main() {
  const env = validateEnv()
  if (!env.ok) {
    console.error(`Missing env: ${env.missing.join(', ')}`)
    process.exit(1)
  }

  const slug = process.argv[2] ?? 'mug-ibm'
  const subject = `test-photos/${slug}.jpg`
  // A product that is not the subject, for the wrong-product case.
  const impostor =
    slug === 'watch-fossil' ? 'test-photos/mug-ibm.jpg' : 'test-photos/watch-fossil.jpg'

  console.log(`Subject:  ${subject}`)
  console.log(`Impostor: ${impostor}\n`)

  // Two reference photos, not one, and the second is the macro. The first version of this
  // script fingerprinted the single listing-size frame, which correctly put "macro of the
  // logo print" on the absent-surfaces list — so the reviewer then rejected a macro crop as
  // an invented surface, and was right to. That is the multi-photo argument in miniature:
  // with one photo there is no candidate that satisfies a detail brief honestly, and no
  // reviewer should pretend otherwise.
  const wide = await load(subject)
  const macro = await macroCrop(subject)
  const reference = wide
  let total = 0

  process.stdout.write('Cataloguing the subject across 2 photos … ')
  const { dna, usage: dnaUsage } = await extractImageDNA([wide, macro])
  total += claudeCostUsd(dnaUsage)
  console.log(`${dna.product}\n`)

  // A plain 'angle' shot: the candidate should be the same product, viewpoint aside. Used
  // for the likeness cases so a rejection is about identity and not about hard rules.
  const angleSlot: Slot = {
    id: 'verify-angle',
    label: 'Verify Angle',
    mode: 'creative',
    kind: 'angle',
    directive: 'The product photographed clearly, filling the frame.',
    sourcePhotos: [0],
  }

  // A detail shot the macro crop genuinely satisfies. The control has to be an image that
  // answers the brief it is reviewed against, not merely an image of the right product.
  const detailSlot: Slot = {
    id: 'verify-detail',
    label: 'Verify Detail',
    mode: 'creative',
    kind: 'detail',
    directive:
      'A macro close-up of the printed marking and the surface around it, framed tightly enough that the finish is the subject of the photograph.',
    sourcePhotos: [1],
  }

  const cases: Case[] = [
    {
      name: 'control — a real macro crop, as a detail shot',
      candidate: macro,
      slot: detailSlot,
      expect: 'pass',
      why: 'A reviewer that rejects the genuine article rejects everything.',
    },
    {
      name: 'wrong product',
      candidate: await load(impostor),
      slot: angleSlot,
      expect: 'reject',
      why: 'The failure the whole stage exists to catch.',
    },
    {
      name: 'recoloured — right shape, wrong colour',
      candidate: await recolour(subject),
      slot: angleSlot,
      expect: 'reject',
      why: 'The subtle case. Everything is right except the thing a buyer is paying for.',
    },
    {
      name: 'coloured background on the locked Main slot',
      candidate: await colouredBackground(subject),
      slot: { ...getSlot('main'), sourcePhotos: [0] },
      expect: 'reject',
      why: 'Hard rules must bite independently of likeness.',
    },
  ]

  let passed = 0
  for (const c of cases) {
    process.stdout.write(`${c.name.padEnd(48)} … `)

    // Locked slots go through the same deterministic correction and measurement the render
    // loop applies before review. Without it the reviewer estimates fill and background
    // itself — which it will do, and which production never asks it to do, so a verdict
    // from this harness would not be comparable with one from /api/render.
    let compliance: ComplianceReport | undefined
    let candidate = c.candidate
    if (c.slot.mode === 'locked') {
      const snapped = await snapWhitePoint(Buffer.from(candidate.data, 'base64'))
      candidate = { data: snapped.buffer.toString('base64'), mediaType: 'image/png' }
      compliance = await checkCompliance(snapped.buffer)
    }

    const { review, usage, ms } = await reviewImage({
      dna: dna as ImageDNA,
      slot: c.slot,
      prompt: '(verification harness — no prompt)',
      // The detail case is reviewed against the macro it was routed to; everything else
      // against the wide frame. Reviewing a macro against a frame that does not resolve the
      // surface produces a defect report about the reference, not about the candidate.
      references: c.slot.kind === 'detail' ? [macro] : [reference],
      candidate,
      compliance,
    })
    total += claudeCostUsd(usage)

    const ok = verdictMatches(review, c.expect)
    if (ok) passed++
    console.log(`${ok ? 'OK  ' : 'FAIL'}  ${describe(review)}  (${(ms / 1000).toFixed(1)}s)`)
    console.log(`      expected ${c.expect}. ${c.why}`)
    for (const d of review.defects) {
      console.log(`      [${d.severity}] ${d.kind}: ${d.description}`)
    }
    if (review.fixInstructions) {
      console.log(`      fix: ${review.fixInstructions.slice(0, 160)}`)
    }
    console.log()
  }

  console.log(`${passed}/${cases.length} cases behaved as expected · ${usd(total)}`)
  // A failing discrimination test means the render loop is retrying the wrong things, or
  // shipping the wrong things, so it exits non-zero and can gate a commit.
  process.exit(passed === cases.length ? 0 : 1)
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
