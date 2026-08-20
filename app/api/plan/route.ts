/**
 * POST /api/plan — decide which shots this particular product needs, and which photo
 * produces each one.
 *
 * Runs once per product, straight after Visual DNA. Returns the slots to generate — each
 * already routed to the photos it will be rendered from — plus the shots that would help
 * this listing but that no uploaded photo supports, so the UI can tell the seller exactly
 * what to photograph rather than the pipeline inventing it.
 *
 * The deferred list is the honest half of the answer and is returned as prominently as the
 * generated half. "Your five photos produce six of seven shots; one photo of the toe
 * unlocks the seventh" is a more useful reply than seven images, two of which are guesses.
 */

import { NextResponse } from 'next/server'
import { planShots, buildSlotSet } from '@/lib/claude/shot-plan'
import type { ImageDNA } from '@/lib/claude/dna'
import { claudeCostUsd } from '@/lib/cost'
import { validateEnv } from '@/lib/config'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function POST(req: Request) {
  const env = validateEnv()
  if (!env.ok) {
    return NextResponse.json(
      { error: `Missing environment variables: ${env.missing.join(', ')}` },
      { status: 500 },
    )
  }

  let body: { dna?: ImageDNA; includePartial?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 })
  }
  if (!body.dna) {
    return NextResponse.json({ error: 'dna is required.' }, { status: 400 })
  }
  if (!Array.isArray(body.dna.photos)) {
    return NextResponse.json(
      {
        error:
          'dna is missing its coverage map (`photos`). Re-run /api/dna — a fingerprint ' +
          'from before multi-photo support cannot be routed.',
      },
      { status: 400 },
    )
  }

  try {
    const { plan, usage, ms } = await planShots(body.dna)
    // ALLOW_COMPOSE lets shots with no supporting photograph be attempted from text alone.
    // Off by default: V1 measured that route distorting the product (height:width 0.89 →
    // 0.66), and a distorted product is worse for the seller than a missing shot.
    const { slots, deferred, deferrals } = buildSlotSet(plan, body.dna, {
      includePartial: body.includePartial,
      allowCompose: process.env.ALLOW_COMPOSE === 'true',
    })

    return NextResponse.json({
      productSummary: plan.productSummary,
      coverageSummary: plan.coverageSummary,
      slots,
      deferred,
      deferrals,
      cost: { usd: claudeCostUsd(usage), ms },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Shot planning failed.' },
      { status: 502 },
    )
  }
}
