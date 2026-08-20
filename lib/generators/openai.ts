/**
 * Stages 3b + 3c — OpenAI, image-to-image and text-to-image.
 *
 * Two model IDs behind one implementation:
 *   gpt-image-1.5  the model the spec names. NOTE: API removal 2026-12-01.
 *   gpt-image-2    its successor, on the API since May 2026.
 *
 * Two render modes, because V1 measured that they are not interchangeable:
 *
 *   'edit'    → images.edit, anchored to the uploaded photo. Preserves identity almost
 *               perfectly. CANNOT change the camera pose — the endpoint is structurally
 *               locked to the reference composition, and `input_fidelity` is already at
 *               its loosest ('low'), so there is no knob left to turn.
 *   'compose' → images.generate, no reference image. The only route measured to actually
 *               produce a different viewpoint, at the cost of some identity drift.
 *
 * Everything that keeps the original viewpoint (crops, close-ups, background and context
 * changes) stays on 'edit'. Only shots that genuinely need the camera to move go to
 * 'compose', because that is where the drift is worth paying for.
 */

import OpenAI, { toFile } from 'openai'
import { IMAGE_SIZE, MODELS, getKeys, openaiInputFidelity, type GeneratorId } from '../config'
import { imageCostUsd } from '../cost'
import type { RenderMode } from '../slots'
import {
  referencesFor,
  withRetry,
  type GenResult,
  type ImageGenerator,
  type PhotoInput,
} from './types'

let client: OpenAI | null = null
function openai(): OpenAI {
  if (!client) client = new OpenAI({ apiKey: getKeys().openai, maxRetries: 0 })
  return client
}

const EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

function makeGenerator(
  id: Extract<GeneratorId, 'openai-1-5' | 'openai-2'>,
  model: string,
  label: string,
): ImageGenerator {
  return {
    id,
    label,

    async generate(
      prompt: string,
      refImages: PhotoInput,
      renderMode: RenderMode = 'edit',
    ): Promise<GenResult> {
      const started = Date.now()
      const references = referencesFor(refImages, renderMode)

      if (renderMode === 'edit' && references.length === 0) {
        throw new Error(
          `${label}: 'edit' needs at least one reference photo. Route the shot to a photo, ` +
            "or set renderMode 'compose' to accept that nothing anchors the product.",
        )
      }

      const call = async () => {
        if (renderMode === 'compose') {
          return openai().images.generate({
            model,
            prompt,
            size: IMAGE_SIZE.openai,
            quality: IMAGE_SIZE.openaiQuality,
          })
        }

        const files = await Promise.all(
          references.map((ref, i) =>
            toFile(
              Buffer.from(ref.data, 'base64'),
              `reference-${i + 1}.${EXT[ref.mediaType] ?? 'png'}`,
              { type: ref.mediaType },
            ),
          ),
        )

        return openai().images.edit({
          model,
          // The endpoint takes an array, and several references is what makes an angle
          // shot a real edit rather than an attempt to synthesise a pose. Filenames are
          // numbered to match the prompt's own "Photo 1 / Photo 2" references, so a
          // prompt saying "the toe as shown in Photo 3" points at something.
          image: files.length === 1 ? files[0] : files,
          prompt,
          size: IMAGE_SIZE.openai,
          quality: IMAGE_SIZE.openaiQuality,
          // 'high' by default. See openaiInputFidelity() in lib/config.ts for the
          // measurement that changed this from V1's 'low': on an in-use shot it took
          // identity from 63 to 85 and halved the cost by removing the retry.
          input_fidelity: openaiInputFidelity(),
        })
      }

      const { value: response, retries } = await withRetry(call, (attempt, err) =>
        console.warn(`[${id}/${renderMode}] retry ${attempt}: ${(err as Error).message}`),
      )

      const b64 = response.data?.[0]?.b64_json
      if (!b64) throw new Error(`${label} returned no image data`)

      // gpt-image-2 bills by token; prefer real usage over the static table.
      let costUsd = imageCostUsd(id)
      const outTok = (response.usage as { output_tokens?: number } | undefined)
        ?.output_tokens
      if (typeof outTok === 'number' && outTok > 0) {
        costUsd = (outTok / 1_000_000) * 30
      }

      return {
        id,
        label,
        imageBase64: b64,
        mimeType: 'image/png',
        costUsd,
        ms: Date.now() - started,
        retries,
        renderMode,
        referenceCount: references.length,
      }
    },
  }
}

export const openai15Generator = makeGenerator(
  'openai-1-5',
  MODELS.openai15,
  'GPT Image 1.5',
)

export const openai2Generator = makeGenerator(
  'openai-2',
  MODELS.openai2,
  'GPT Image 2',
)
