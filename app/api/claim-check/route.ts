/**
 * POST /api/claim-check — Stage 2 spec §13.
 *
 * Every piece of text destined for an infographic passes through here before it is rendered.
 * A rejected claim comes back rewritten; it is never returned as publishable, and there is no
 * override parameter, because §13 and §18 are explicit that the seller gets no override path.
 *
 * Separate from the render routes because the check sits at a different point in the pipeline
 * — text is checked before it becomes pixels, not after — and because it is the one gate that
 * has to be callable on its own, while a seller is still typing.
 */

import { NextResponse } from 'next/server'
import { checkClaims } from '@/lib/claim-check'
import { claudeCostUsd } from '@/lib/cost'
import { validateEnv } from '@/lib/config'

export const runtime = 'nodejs'
export const maxDuration = 300

/** Callouts per request. The infographic template holds four; this leaves room to triage. */
const MAX_TEXTS = 12

export async function POST(req: Request) {
  const env = validateEnv()
  if (!env.ok) {
    return NextResponse.json(
      { error: `Missing environment variables: ${env.missing.join(', ')}` },
      { status: 500 },
    )
  }

  let body: { texts?: string[]; text?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 })
  }

  const texts = body.texts?.length ? body.texts : body.text ? [body.text] : []
  if (!texts.length) {
    return NextResponse.json({ error: 'texts[] or text is required.' }, { status: 400 })
  }
  if (texts.length > MAX_TEXTS) {
    return NextResponse.json(
      { error: `${texts.length} texts supplied; the maximum is ${MAX_TEXTS}.` },
      { status: 400 },
    )
  }

  try {
    const { results, safeTexts, usdTokens } = await checkClaims(texts)
    const usd = usdTokens.reduce((sum, u) => sum + claudeCostUsd(u), 0)

    return NextResponse.json({
      results,
      // The only text the caller may render. Anything dropped is absent by construction
      // rather than present with a flag, so a caller cannot ship it by ignoring a boolean.
      safeTexts,
      allClean: results.every((r) => r.clean),
      droppedCount: results.filter((r) => r.dropped).length,
      cost: { usd },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Claim check failed.' },
      { status: 502 },
    )
  }
}
