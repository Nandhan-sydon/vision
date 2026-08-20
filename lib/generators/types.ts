import type { GeneratorId } from '../config'
import type { RenderMode } from '../slots'
import { toPhotoArray, type Base64Image, type PhotoInput } from '../photos'

export type { Base64Image, PhotoInput }

export type GenResult = {
  id: GeneratorId
  label: string
  imageBase64: string
  mimeType: string
  costUsd: number
  ms: number
  /** Retries actually performed — spec §8 asks for rate limits to be reported. */
  retries: number
  /** Which route produced this image. Recorded so the report can compare the two. */
  renderMode: RenderMode
  /** How many reference photos this render was anchored on. 0 for 'compose'. */
  referenceCount: number
}

export type GenFailure = {
  id: GeneratorId
  label: string
  error: string
  ms: number
  retries: number
}

export interface ImageGenerator {
  id: GeneratorId
  label: string
  /**
   * `refImages` is the photo set the SHOT is routed to, not everything the seller
   * uploaded. The caller narrows it with `selectPhotos()` first, because handing a
   * grip-macro render five frames that do not show the grip dilutes the reference it is
   * meant to be anchored to.
   *
   * `renderMode` decides whether those photos anchor the result ('edit') or are dropped
   * and the prompt alone is used ('compose'). 'compose' exists only for shots no
   * photograph supports; it is the route V1 measured to distort the product, so it is a
   * last resort rather than the way to change viewpoint. Accepts a single image for
   * callers that still have exactly one.
   */
  generate(
    prompt: string,
    refImages: PhotoInput,
    renderMode?: RenderMode,
  ): Promise<GenResult>
}

/**
 * Reference photos for a render, in call order.
 *
 * 'compose' returns none deliberately rather than being handled at each call site: the
 * mode's entire definition is "no photograph anchors this", and leaving that to three
 * generator implementations to remember invites one of them to pass a reference anyway
 * and quietly reintroduce the composition lock the mode exists to escape.
 */
export function referencesFor(
  input: PhotoInput,
  renderMode: RenderMode,
): Base64Image[] {
  return renderMode === 'compose' ? [] : toPhotoArray(input)
}

/**
 * One retry on transient failures only. Rate limits and 5xx are worth retrying;
 * a 400 from a malformed request is not, and retrying it just doubles the latency
 * before the real error surfaces.
 */
export function isTransient(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  if (status === 429 || (typeof status === 'number' && status >= 500)) return true
  const msg = String((err as Error)?.message ?? err).toLowerCase()
  return (
    msg.includes('429') ||
    msg.includes('rate limit') ||
    msg.includes('overloaded') ||
    msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('etimedout')
  )
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  onRetry: (attempt: number, err: unknown) => void,
  maxRetries = 1,
): Promise<{ value: T; retries: number }> {
  let attempt = 0
  for (;;) {
    try {
      return { value: await fn(), retries: attempt }
    } catch (err) {
      if (attempt >= maxRetries || !isTransient(err)) throw err
      attempt += 1
      onRetry(attempt, err)
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
}
