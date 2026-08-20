/**
 * POST /api/generate — render one prompt with one generator. One shot, no review.
 *
 * Deliberately one generator per request. Measured latencies are ~40s for GPT Image 1.5
 * and ~140s for GPT Image 2, so fanning out server-side inside a single request would risk
 * the serverless duration cap. The browser issues these in parallel and shows one loading
 * state for the slot regardless of how many are in flight.
 *
 * This route stays deliberately dumb: prompt in, image out. The reviewed-and-retried path
 * is `/api/render`, which owns prompt writing, correction, review and retry because all
 * four have to share state across attempts. Keeping this one available matters for the
 * side-by-side generator comparison, where a review loop would confound the measurement by
 * giving one vendor more attempts than another.
 */

import { NextResponse } from 'next/server'
import { geminiGenerator } from '@/lib/generators/gemini'
import { openai15Generator, openai2Generator } from '@/lib/generators/openai'
import type { ImageGenerator } from '@/lib/generators/types'
import { validateEnv, type GeneratorId } from '@/lib/config'
import type { RenderMode } from '@/lib/slots'
import { selectPhotos, validatePhotos, type Base64Image } from '@/lib/photos'
import { appendRunRecord, saveImage } from '@/lib/storage'

export const runtime = 'nodejs'
export const maxDuration = 300

const GENERATORS: Record<GeneratorId, ImageGenerator> = {
  gemini: geminiGenerator,
  'openai-1-5': openai15Generator,
  'openai-2': openai2Generator,
}

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
    generatorId?: GeneratorId
    prompt?: string
    photos?: PhotoPayload[]
    imageBase64?: string
    mediaType?: string
    /** Indexes into `photos` this shot is routed to. Omit to use every photo. */
    sourcePhotos?: number[]
    runId?: string
    slotId?: string
    hintHandling?: string
    renderMode?: RenderMode
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Body must be JSON.' }, { status: 400 })
  }

  const { generatorId, prompt } = body
  if (!generatorId || !prompt) {
    return NextResponse.json(
      { error: 'generatorId and prompt are required.' },
      { status: 400 },
    )
  }

  const collected: Base64Image[] = Array.isArray(body.photos) && body.photos.length
    ? body.photos.map((p) => ({
        data: p.imageBase64 ?? p.data ?? '',
        mediaType: p.mediaType ?? '',
      }))
    : body.imageBase64 && body.mediaType
      ? [{ data: body.imageBase64, mediaType: body.mediaType }]
      : []

  const renderMode = body.renderMode ?? 'edit'

  // 'compose' is the one mode that legitimately runs with nothing to anchor it, so the
  // photo requirement is conditional rather than universal.
  if (renderMode === 'edit') {
    if (collected.length === 0) {
      return NextResponse.json(
        { error: 'photos[] (or imageBase64 and mediaType) is required for renderMode "edit".' },
        { status: 400 },
      )
    }
    const check = validatePhotos(collected)
    if (!check.ok) return NextResponse.json({ error: check.error }, { status: 400 })
  }

  const generator = GENERATORS[generatorId]
  if (!generator) {
    return NextResponse.json(
      { error: `Unknown generator "${generatorId}".` },
      { status: 400 },
    )
  }

  const { photos: references, usedIndexes } = selectPhotos(collected, body.sourcePhotos)

  const started = Date.now()
  try {
    const result = await generator.generate(prompt, references, renderMode)

    let savedPath: string | null = null
    if (body.runId && body.slotId) {
      savedPath = await saveImage(
        body.runId,
        `${body.slotId}-${generatorId}`,
        result.imageBase64,
        result.mimeType,
      )
      await appendRunRecord(body.runId, {
        slotId: body.slotId,
        generatorId,
        prompt,
        hintHandling: body.hintHandling ?? null,
        costUsd: result.costUsd,
        ms: result.ms,
        retries: result.retries,
        renderMode: result.renderMode,
        referenceIndexes: usedIndexes,
        savedPath,
      })
    }

    return NextResponse.json({
      id: result.id,
      label: result.label,
      dataUrl: `data:${result.mimeType};base64,${result.imageBase64}`,
      costUsd: result.costUsd,
      ms: result.ms,
      retries: result.retries,
      renderMode: result.renderMode,
      referenceIndexes: usedIndexes,
      savedPath,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Generation failed.'
    if (body.runId && body.slotId) {
      await appendRunRecord(body.runId, {
        slotId: body.slotId,
        generatorId,
        prompt,
        error: message,
        ms: Date.now() - started,
      })
    }
    // 200 with an error field: one vendor failing must not blank the slot, and the
    // client renders per-generator errors alongside whichever images did come back.
    return NextResponse.json({
      id: generatorId,
      label: generator.label,
      error: message,
      ms: Date.now() - started,
    })
  }
}
