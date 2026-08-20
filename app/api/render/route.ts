/**
 * POST /api/render — produce one shot properly: write, generate, correct, review, retry.
 *
 * This is the route the UI uses. `/api/generate` remains the raw single-shot call for the
 * generator comparison, where handing one vendor extra attempts would confound the
 * measurement.
 *
 * One generator per request, for the same reason `/api/generate` is: a single attempt runs
 * 40-140s, and up to three attempts plus two reviews has to fit inside the platform's
 * duration cap. The browser fans out across generators and shows one loading state per
 * shot.
 *
 * ## Why the whole loop lives server-side rather than the browser driving it
 *
 * The retry is not "call generate again". It is: correct the image deterministically,
 * review it against the seller's real photographs, and rewrite the prompt from the specific
 * defects that came back. Driving that from the client would put the Visual DNA, the
 * reviewer's defect list and the prompt writer's rules on the wire three times per shot,
 * and would let a client skip the correction step before review — which would make every
 * review report the same background defect and burn the retry budget on it.
 */

import { NextResponse } from 'next/server'
import { geminiGenerator } from '@/lib/generators/gemini'
import { openai15Generator, openai2Generator } from '@/lib/generators/openai'
import type { ImageGenerator } from '@/lib/generators/types'
import { validateEnv, type GeneratorId } from '@/lib/config'
import type { Slot } from '@/lib/slots'
import { getSlot } from '@/lib/slots'
import type { ImageDNA } from '@/lib/claude/dna'
import { renderShot, DEFAULT_MAX_ATTEMPTS } from '@/lib/render-shot'
import { validatePhotos, type Base64Image } from '@/lib/photos'
import { productKey } from '@/lib/product-key'
import {
  emptyMemory,
  loadBuildMemory,
  mergeMemory,
  saveBuildMemory,
  type BuildMemory,
} from '@/lib/build-memory'
import { appendRunRecord, saveImage } from '@/lib/storage'

export const runtime = 'nodejs'
export const maxDuration = 300

const GENERATORS: Record<GeneratorId, ImageGenerator> = {
  gemini: geminiGenerator,
  'openai-1-5': openai15Generator,
  'openai-2': openai2Generator,
}

type PhotoPayload = { imageBase64?: string; data?: string; mediaType?: string }

/**
 * Three attempts × up to ~140s of generation plus two reviews does not fit in 300s on the
 * slowest generator. Rather than fail late with a platform timeout — which loses every
 * attempt already paid for — the cap is applied up front and reported in the response, so
 * a run that wanted more attempts knows it did not get them.
 */
const SLOW_GENERATORS: GeneratorId[] = ['openai-2']
const SLOW_MAX_ATTEMPTS = 2

export async function POST(req: Request) {
  const env = validateEnv()
  if (!env.ok) {
    return NextResponse.json(
      { error: `Missing environment variables: ${env.missing.join(', ')}` },
      { status: 500 },
    )
  }

  let body: {
    generatorId?: GeneratorId
    dna?: ImageDNA
    slot?: Slot
    slotId?: string
    photos?: PhotoPayload[]
    hint?: string
    maxAttempts?: number
    review?: boolean
    runId?: string
    /**
     * Build memory the client is holding (spec §7).
     *
     * Merged with the server's stored copy rather than replacing it. On a deployment with no
     * Blob store the server keeps nothing between requests, so the client is the only thing
     * with continuity — and losing it silently would reintroduce exactly the cross-shot drift
     * build memory exists to prevent.
     */
    buildMemory?: BuildMemory
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 })
  }

  const { generatorId } = body
  if (!generatorId) {
    return NextResponse.json({ error: 'generatorId is required.' }, { status: 400 })
  }
  const generator = GENERATORS[generatorId]
  if (!generator) {
    return NextResponse.json({ error: `Unknown generator "${generatorId}".` }, { status: 400 })
  }
  if (!body.dna) {
    return NextResponse.json({ error: 'dna is required.' }, { status: 400 })
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
  if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })

  const requested = body.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const cap = SLOW_GENERATORS.includes(generatorId) ? SLOW_MAX_ATTEMPTS : DEFAULT_MAX_ATTEMPTS
  const maxAttempts = Math.min(requested, cap)

  const key = productKey(body.dna)

  try {
    const stored = await loadBuildMemory(key)
    const buildMemory = body.buildMemory
      ? mergeMemory({ ...body.buildMemory, productKey: key }, stored)
      : stored

    const outcome = await renderShot({
      generator,
      dna: body.dna,
      slot,
      photos: check.photos,
      hint: body.hint,
      buildMemory: buildMemory.entries.length ? buildMemory : emptyMemory(key),
      maxAttempts,
      review: body.review ?? true,
    })

    await saveBuildMemory(outcome.buildMemory)

    let savedPath: string | null = null
    if (body.runId) {
      // Every attempt is saved, not only the one being shipped. A reviewer that rejected
      // attempt 1 and passed attempt 2 is a claim, and the run folder is where that claim
      // can be checked by eye.
      for (const attempt of outcome.attempts) {
        const path = await saveImage(
          body.runId,
          `${slot.id}-${generatorId}-a${attempt.n}`,
          attempt.imageBase64,
          attempt.mimeType,
        )
        if (attempt.n === outcome.best.n) savedPath = path
      }
      await appendRunRecord(body.runId, {
        slotId: slot.id,
        generatorId,
        passed: outcome.passed,
        stoppedBecause: outcome.stoppedBecause,
        attempts: outcome.attempts.map((a) => ({
          n: a.n,
          prompt: a.prompt,
          referenceIndexes: a.referenceIndexes,
          verdict: a.review?.verdict,
          scores: a.review?.scores,
          defects: a.review?.defects,
          costUsd: a.costUsd,
          ms: a.ms,
        })),
        costUsd: outcome.costUsd,
        ms: outcome.ms,
        savedPath,
      })
    }

    return NextResponse.json({
      id: generatorId,
      label: generator.label,
      slotId: slot.id,
      slotLabel: slot.label,
      dataUrl: `data:${outcome.best.mimeType};base64,${outcome.best.imageBase64}`,
      passed: outcome.passed,
      stoppedBecause: outcome.stoppedBecause,
      sellerNote: outcome.sellerNote,
      attemptsUsed: outcome.attempts.length,
      maxAttempts,
      // Surfaced so a run that asked for three attempts on a slow generator can see it was
      // given two, rather than reading an early stop as a confident pass.
      attemptsCapped: maxAttempts < requested,
      // Images are stripped: three PNGs per shot per generator would make the response
      // enormous and the client only renders the one being shipped.
      attempts: outcome.attempts.map((a) => ({
        n: a.n,
        prompt: a.prompt,
        hintHandling: a.hintHandling,
        referenceIndexes: a.referenceIndexes,
        verdict: a.review?.verdict ?? null,
        scores: a.review?.scores ?? null,
        defects: a.review?.defects ?? [],
        summary: a.review?.summary ?? '',
        compliance: a.compliance
          ? {
              released: a.compliance.released,
              width: a.compliance.width,
              height: a.compliance.height,
              bytes: a.compliance.bytes,
              amazonReady: a.compliance.amazonReady,
              fillLinearPct: a.compliance.fillLinearPct,
              bgMaxDeviation: a.compliance.bgMaxDeviation,
              touchesEdge: a.compliance.touchesEdge,
              actions: a.compliance.actions,
              notes: a.compliance.notes,
            }
          : null,
        costUsd: a.costUsd,
        ms: a.ms,
      })),
      bestAttempt: outcome.best.n,
      // Returned so the client can carry it into the next shot even where the server has no
      // persistent store. See the buildMemory note on the request body.
      buildMemory: outcome.buildMemory,
      productKey: key,
      style: {
        lighting: outcome.best.style.lighting.id,
        scene: outcome.best.style.scene?.id ?? null,
        shadow: outcome.best.style.shadow,
      },
      promptUsed: outcome.best.prompt,
      hintHandling: outcome.best.hintHandling,
      costUsd: outcome.costUsd,
      ms: outcome.ms,
      savedPath,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Render failed.'
    if (body.runId) {
      await appendRunRecord(body.runId, { slotId: slot.id, generatorId, error: message })
    }
    // 200 with an error field, matching /api/generate: one vendor failing must not blank
    // the slot when the client is fanning out across several.
    return NextResponse.json({
      id: generatorId,
      label: generator.label,
      slotId: slot.id,
      error: message,
    })
  }
}
