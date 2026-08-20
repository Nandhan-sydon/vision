/**
 * POST /api/prompt — write the generation prompt for one slot.
 *
 * Accepts either a `slotId` (compliance slots such as Main, which are ours and fixed) or
 * a whole `slot` object (shots planned per product by /api/plan). Slots became data the
 * moment the shot list started varying by product, so this route no longer assumes it
 * can look every slot up in a static registry.
 *
 * Split from /api/generate because a measured image call runs 40-140s; combining prompt
 * writing with generation in one request would exceed any serverless duration cap.
 *
 * The reviewed path does not use this route: /api/render calls the prompt writer directly,
 * because a rewrite after a rejection needs the previous prompt and the reviewer's defect
 * list, and shipping that round trip through the browser gains nothing. This route stays
 * for the unreviewed single-shot flow and for inspecting what the writer produces for a
 * given slot without paying for an image.
 */

import { NextResponse } from 'next/server'
import { writePrompt } from '@/lib/claude/prompt'
import type { ImageDNA } from '@/lib/claude/dna'
import { getSlot, type Slot } from '@/lib/slots'
import { claudeCostUsd } from '@/lib/cost'
import { validateEnv, enabledGenerators } from '@/lib/config'

export const runtime = 'nodejs'
export const maxDuration = 300

function resolveSlot(body: { slotId?: string; slot?: Slot }): Slot {
  if (body.slot?.id && body.slot.directive) return body.slot
  if (body.slotId) return getSlot(body.slotId)
  throw new Error('Either slot or slotId is required.')
}

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
    slotId?: string
    slot?: Slot
    hint?: string
    /** Photo indexes the generator will receive. Defaults to the slot's own routing. */
    referenceIndexes?: number[]
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 })
  }
  if (!body.dna) {
    return NextResponse.json({ error: 'dna is required.' }, { status: 400 })
  }

  try {
    const slot = resolveSlot(body)
    const { result, usage, ms } = await writePrompt({
      dna: body.dna,
      slot,
      hint: body.hint,
      referenceIndexes: body.referenceIndexes,
    })

    return NextResponse.json({
      prompt: result.prompt,
      // Logged for the report, never rendered to the user (spec §10).
      hintHandling: result.hintHandling,
      // The server owns which generators are live, so the UI never renders a tile for
      // one that is switched off.
      generators: enabledGenerators(),
      cost: { usd: claudeCostUsd(usage), ms, usage },
    })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Prompt writing failed.' },
      { status: 502 },
    )
  }
}
