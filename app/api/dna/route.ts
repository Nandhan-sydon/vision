/**
 * POST /api/dna — derive the Visual DNA for an uploaded photo set.
 *
 * Called ONCE per product, on upload, across every photo at once. The client holds the
 * result and passes it back for every slot, so all shots are written against one shared
 * definition of the product (spec §7).
 *
 * Deriving it from the whole set in a single call is not an optimisation. The coverage map
 * it returns — which photo shows which surface, and which surfaces none of them show — can
 * only be produced by a pass that sees all the photos together, and that map is what every
 * later stage routes on.
 *
 * Accepts `photos: [{ imageBase64, mediaType }]`, and still accepts a single
 * `imageBase64`/`mediaType` pair.
 */

import { NextResponse } from 'next/server'
import { extractImageDNA } from '@/lib/claude/dna'
import { claudeCostUsd } from '@/lib/cost'
import { validateEnv } from '@/lib/config'
import { RECOMMENDED_MIN_PHOTOS, validatePhotos, type Base64Image } from '@/lib/photos'

export const runtime = 'nodejs'
export const maxDuration = 300

type PhotoPayload = { imageBase64?: string; data?: string; mediaType?: string }

function collectPhotos(body: {
  photos?: PhotoPayload[]
  imageBase64?: string
  mediaType?: string
}): Base64Image[] {
  if (Array.isArray(body.photos) && body.photos.length) {
    return body.photos.map((p) => ({
      data: p.imageBase64 ?? p.data ?? '',
      mediaType: p.mediaType ?? '',
    }))
  }
  if (body.imageBase64 && body.mediaType) {
    return [{ data: body.imageBase64, mediaType: body.mediaType }]
  }
  return []
}

export async function POST(req: Request) {
  const env = validateEnv()
  if (!env.ok) {
    return NextResponse.json(
      { error: `Missing environment variables: ${env.missing.join(', ')}` },
      { status: 500 },
    )
  }

  let body: { photos?: PhotoPayload[]; imageBase64?: string; mediaType?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 })
  }

  const collected = collectPhotos(body)
  if (collected.length === 0) {
    return NextResponse.json(
      { error: 'photos[] (or imageBase64 and mediaType) is required.' },
      { status: 400 },
    )
  }

  const check = validatePhotos(collected)
  if (!check.ok) {
    return NextResponse.json({ error: check.error }, { status: 400 })
  }

  try {
    const { dna, usage, ms } = await extractImageDNA(check.photos)

    // Advice, not a gate. A one-photo upload still works and still produces an honest
    // coverage map — it simply produces a thin one, and the seller is better served by
    // being told that up front than by discovering it in the deferred-shots list.
    const advice =
      dna.photoCount < RECOMMENDED_MIN_PHOTOS
        ? `${dna.photoCount} photo${dna.photoCount === 1 ? '' : 's'} supplied. ` +
          `${RECOMMENDED_MIN_PHOTOS} or more lets more shots be produced from real ` +
          'photographs rather than deferred back to you.'
        : ''

    return NextResponse.json({
      dna,
      advice,
      unusablePhotos: dna.photos
        .filter((p) => !p.usable)
        .map((p) => ({ index: p.index, issue: p.issue })),
      cost: { usd: claudeCostUsd(usage), ms, usage },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Visual DNA extraction failed.' },
      { status: 502 },
    )
  }
}
