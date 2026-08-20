/**
 * Stage 3a — Gemini 3 Pro Image (Nano Banana Pro).
 *
 * Uses `:generateContent` rather than the newer `/v1beta/interactions`. Interactions is
 * GA and is Google's general recommendation for new projects, but what it adds is
 * server-side conversation state, persistence, background execution, and an agent
 * surface — none of which a stateless one-shot render uses. Google points single-shot,
 * latency-sensitive work with API-stability requirements at `generateContent`, which is
 * also where the image-to-image examples live. The `interactions` equivalent is
 * documented at the bottom of this file; swapping is isolated to this module.
 *
 * Render modes map cleanly onto one endpoint here — the reference photo is simply a part
 * that is present or absent:
 *   'edit'    → text part + inlineData part (the uploaded photo anchors the result)
 *   'compose' → text part only (nothing anchors the composition, so the camera can move)
 *
 * NOT YET VERIFIED AGAINST THE LIVE API. The key available during development was on the
 * free tier, where gemini-3-pro-image has a request quota of 0, so every call 429s. The
 * request shape below follows Google's REST reference; treat the first real call as the
 * verification step and expect to adjust `imageConfig` if the response comes back at the
 * wrong resolution (a known rough edge in some clients).
 */

import { IMAGE_SIZE, MODELS, getKeys } from '../config'
import { photoLabel } from '../photos'
import { imageCostUsd } from '../cost'
import type { RenderMode } from '../slots'
import {
  referencesFor,
  withRetry,
  type GenResult,
  type ImageGenerator,
  type PhotoInput,
} from './types'

const ENDPOINT = (model: string) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`

type Part = {
  text?: string
  inlineData?: { mimeType?: string; data?: string }
}

type GeminiResponse = {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[]
  promptFeedback?: { blockReason?: string }
  error?: { message?: string; status?: string }
}

export const geminiGenerator: ImageGenerator = {
  id: 'gemini',
  label: 'Gemini 3 Pro Image',

  async generate(
    prompt: string,
    refImages: PhotoInput,
    renderMode: RenderMode = 'edit',
  ): Promise<GenResult> {
    const started = Date.now()
    const apiKey = getKeys().gemini
    const references = referencesFor(refImages, renderMode)

    if (renderMode === 'edit' && references.length === 0) {
      throw new Error(
        "Gemini: 'edit' needs at least one reference photo. Route the shot to a photo, " +
          "or set renderMode 'compose' to accept that nothing anchors the product.",
      )
    }

    // Text first, then the references, each preceded by its own label. generateContent
    // takes an arbitrary number of inline parts, and the labels are what let a prompt
    // refer to "Photo 2" and have the model resolve it — without them, several
    // references are an undifferentiated pile and the model averages across them, which
    // is the failure mode multiple photos are supposed to remove.
    const parts: Part[] = [{ text: prompt }]
    for (const [i, ref] of references.entries()) {
      parts.push({ text: `--- ${photoLabel(i)} ---` })
      parts.push({ inlineData: { mimeType: ref.mediaType, data: ref.data } })
    }

    const body = {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        // Must include TEXT alongside IMAGE — IMAGE alone is rejected.
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: IMAGE_SIZE.gemini.aspectRatio,
          imageSize: IMAGE_SIZE.gemini.imageSize,
        },
      },
    }

    const { value: json, retries } = await withRetry(
      async () => {
        const res = await fetch(ENDPOINT(MODELS.gemini), {
          method: 'POST',
          headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const parsed = (await res.json()) as GeminiResponse
        if (!res.ok) {
          const err = new Error(
            `Gemini ${res.status}: ${parsed.error?.message ?? res.statusText}`,
          )
          ;(err as { status?: number }).status = res.status
          throw err
        }
        return parsed
      },
      (attempt, err) =>
        console.warn(`[gemini/${renderMode}] retry ${attempt}: ${(err as Error).message}`),
    )

    const blocked = json.promptFeedback?.blockReason
    if (blocked) throw new Error(`Gemini blocked the prompt: ${blocked}`)

    const returned = json.candidates?.[0]?.content?.parts ?? []
    const image = returned.find((p) => p.inlineData?.data)?.inlineData
    if (!image?.data) {
      // With responseModalities including TEXT, a refusal or clarification comes back as
      // a text part instead of an image — surface it rather than a bare "no image".
      const text = returned.find((p) => p.text)?.text
      const finish = json.candidates?.[0]?.finishReason
      throw new Error(
        `Gemini returned no image (finishReason: ${finish ?? 'unknown'})` +
          (text ? `: ${text.slice(0, 200)}` : ''),
      )
    }

    return {
      id: 'gemini',
      label: geminiGenerator.label,
      imageBase64: image.data,
      mimeType: image.mimeType ?? 'image/png',
      costUsd: imageCostUsd('gemini'),
      ms: Date.now() - started,
      retries,
      renderMode,
      referenceCount: references.length,
    }
  },
}

/*
 * Alternative surface: the Interactions API. Same model, stateful.
 *
 *   POST https://generativelanguage.googleapis.com/v1beta/interactions
 *   {
 *     "model": "gemini-3-pro-image",
 *     "input": [
 *       { "type": "text",  "text": prompt },
 *       { "type": "image", "mime_type": refImage.mediaType, "data": refImage.data }
 *     ],
 *     "response_format": { "type": "image", "aspect_ratio": "1:1", "image_size": "2K" }
 *   }
 *
 * Image bytes arrive at `interaction.output_image.data`. Worth switching to only if this
 * pipeline later needs multi-turn refinement of a single image.
 */
