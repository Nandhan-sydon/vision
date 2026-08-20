/**
 * POST /api/review — review one image against the seller's real photographs.
 *
 * The reviewer runs inside `/api/render` on every attempt, so this route is not part of
 * the normal flow. It exists so a reviewer decision can be reproduced in isolation:
 * re-review a saved image, check a verdict that looked wrong, or run the reviewer against
 * a hand-picked image to see whether it catches a defect at all.
 *
 * That last use is the point. A reviewer nobody can test independently is a component that
 * appears to work because it is never contradicted, and this one is now gating what reaches
 * a live listing. `scripts/verify-review.ts` drives this logic directly.
 *
 * Runs the same deterministic correction as the render loop before reviewing locked slots,
 * so a verdict from this route is comparable with one from `/api/render`.
 */

import { NextResponse } from 'next/server'
import { reviewImage } from '@/lib/claude/review'
import type { ImageDNA } from '@/lib/claude/dna'
import { getSlot, type Slot } from '@/lib/slots'
import { checkCompliance } from '@/lib/compliance'
import { snapWhitePoint } from '@/lib/postprocess'
import { claudeCostUsd } from '@/lib/cost'
import { validateEnv } from '@/lib/config'
import { selectPhotos, validatePhotos, type Base64Image } from '@/lib/photos'

export const runtime = 'nodejs'
export const maxDuration = 300

type PhotoPayload = { imageBase64?: string; data?: string; mediaType?: string }

export async function POST(req: Request) {
  const env = validateEnv()
  if (!env.ok) {
    return NextResponse.json(
      { error: `Missing environment variables: ${env.missing.join(', ')}` },
      { status: 500 },
    )
  }

  let body: {
    dna?: ImageDNA
    slot?: Slot
    slotId?: string
    prompt?: string
    photos?: PhotoPayload[]
    sourcePhotos?: number[]
    candidate?: PhotoPayload
    /** Set false to review the image exactly as supplied, without white-point correction. */
    correct?: boolean
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 })
  }

  if (!body.dna) {
    return NextResponse.json({ error: 'dna is required.' }, { status: 400 })
  }
  if (!body.candidate?.imageBase64 && !body.candidate?.data) {
    return NextResponse.json({ error: 'candidate is required.' }, { status: 400 })
  }

  let slot: Slot
  try {
    slot = body.slot?.id && body.slot.directive ? body.slot : getSlot(body.slotId ?? '')
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Either slot or slotId is required.' },
      { status: 400 },
    )
  }

  const collected: Base64Image[] = (body.photos ?? []).map((p) => ({
    data: p.imageBase64 ?? p.data ?? '',
    mediaType: p.mediaType ?? '',
  }))
  const check = validatePhotos(collected)
  if (!check.ok) {
    return NextResponse.json(
      {
        error:
          `${check.error} The reviewer compares the candidate against the seller's real ` +
          'photographs; without them it can only judge whether the image is attractive.',
      },
      { status: 400 },
    )
  }

  const { photos: references } = selectPhotos(check.photos, body.sourcePhotos ?? slot.sourcePhotos)

  let candidate: Base64Image = {
    data: body.candidate.imageBase64 ?? body.candidate.data ?? '',
    mediaType: body.candidate.mediaType ?? 'image/png',
  }

  try {
    let compliance
    if (slot.mode === 'locked') {
      const raw = Buffer.from(candidate.data, 'base64')
      if (body.correct === false) {
        compliance = await checkCompliance(raw)
      } else {
        const snapped = await snapWhitePoint(raw)
        candidate = { data: snapped.buffer.toString('base64'), mediaType: 'image/png' }
        compliance = await checkCompliance(snapped.buffer)
      }
    }

    const { review, usage, ms } = await reviewImage({
      dna: body.dna,
      slot,
      prompt: body.prompt ?? '(not supplied)',
      references,
      candidate,
      compliance,
    })

    return NextResponse.json({
      review,
      compliance: compliance ?? null,
      cost: { usd: claudeCostUsd(usage), ms, usage },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Review failed.' },
      { status: 502 },
    )
  }
}
