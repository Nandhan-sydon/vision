/**
 * The photo set — the multi-photo spine of the pipeline.
 *
 * V1 took one photo and measured that this is the binding constraint: `images.edit` is
 * structurally anchored to the reference composition, so a viewpoint the seller never
 * photographed cannot be synthesised, and asking for it anyway returns either a copy of
 * the front view or a distorted product. Multiple photos remove the need to synthesise
 * anything — the angle the shot needs is one the seller already took.
 *
 * Every downstream stage therefore addresses photos BY INDEX, and that indexing is the
 * whole anti-hallucination mechanism:
 *
 *   fingerprint  records which photo shows which surface
 *   shot plan    routes each shot to the photos that actually support it
 *   render       hands the generator only those photos
 *   review       compares the candidate against only those photos
 *
 * A shot whose surface appears in no photo is never rendered from an adjacent one. It is
 * reported back to the seller as a photograph to take. An invented base that omits a
 * real maker's stamp is a misleading listing image, not merely a weak one.
 */

export type Base64Image = { data: string; mediaType: string }

/** What a caller supplies: one photo or many. Normalised immediately. */
export type PhotoInput = Base64Image | Base64Image[]

export const ALLOWED_MEDIA = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
] as const

/**
 * Upper bound on photos accepted in one set.
 *
 * Not a model limit — a cost and coherence limit. Every photo is billed on every Claude
 * vision call that sees the set (fingerprint, and each review), so the marginal photo
 * has to earn its place. Past roughly eight views of one object the extra frames are
 * near-duplicates that add tokens without adding coverage.
 */
export const MAX_PHOTOS = 8

/**
 * Stage 2 spec §2. A HARD floor, not advice — §18 forbids running below it.
 *
 * One photo cannot support the pipeline honestly. It gives no second view to confirm an
 * attribute against, so every surface it does not show lands on the refuse-to-invent list,
 * and the reviewer has nothing to compare a candidate's geometry against but the one frame
 * the generator was already anchored to. Measured directly: fingerprinting a single frame
 * correctly put "macro of the logo print" on the absent-surfaces list, so a detail shot had
 * no honest route at all.
 */
export const MIN_PHOTOS = 2

/** Below this, coverage is thin enough that most shots defer back to the seller. */
export const RECOMMENDED_MIN_PHOTOS = 3

export function toPhotoArray(input: PhotoInput): Base64Image[] {
  return Array.isArray(input) ? input : [input]
}

/**
 * Reject a bad set at the edge rather than three API calls in.
 *
 * Returns the reason as a string so routes and scripts can report it identically.
 */
export function validatePhotos(input: PhotoInput): { ok: true; photos: Base64Image[] } | { ok: false; error: string } {
  const photos = toPhotoArray(input)

  if (photos.length < MIN_PHOTOS) {
    return {
      ok: false,
      error:
        `${photos.length} photo${photos.length === 1 ? '' : 's'} supplied; at least ` +
        `${MIN_PHOTOS} distinct photos of the product are required. A single photo leaves ` +
        'every surface it does not show unverifiable, so the shots that matter would all be ' +
        'deferred back to you rather than generated.',
    }
  }
  if (photos.length > MAX_PHOTOS) {
    return {
      ok: false,
      error: `${photos.length} photos supplied; the maximum is ${MAX_PHOTOS}. Each photo is billed on every vision call, and beyond ${MAX_PHOTOS} views of one object the extra frames are near-duplicates.`,
    }
  }
  for (const [i, photo] of photos.entries()) {
    if (!photo?.data || !photo?.mediaType) {
      return { ok: false, error: `Photo ${i + 1} is missing data or mediaType.` }
    }
    if (!ALLOWED_MEDIA.includes(photo.mediaType as (typeof ALLOWED_MEDIA)[number])) {
      return {
        ok: false,
        error: `Photo ${i + 1} has unsupported type "${photo.mediaType}". Use one of: ${ALLOWED_MEDIA.join(', ')}.`,
      }
    }
  }
  return { ok: true, photos }
}

/**
 * Photos are referred to by a 1-based human label everywhere a model can see them, and
 * by a 0-based array index everywhere code touches them.
 *
 * Two numbering schemes is a bug source, so the conversion lives here only. Models are
 * consistently poor at 0-based counting of things they are looking at, and the
 * fingerprint's photo→surface map is worthless if it is off by one.
 */
export function photoLabel(index: number): string {
  return `Photo ${index + 1}`
}

/** Parse a model-supplied 1-based label list back to array indexes, dropping nonsense. */
export function toIndexes(labels: number[], photoCount: number): number[] {
  const seen = new Set<number>()
  for (const label of labels) {
    const index = label - 1
    if (Number.isInteger(index) && index >= 0 && index < photoCount) seen.add(index)
  }
  return [...seen].sort((a, b) => a - b)
}

/**
 * The photos a single shot is rendered from.
 *
 * `sourcePhotos` comes from the shot plan's coverage analysis. An empty or unusable list
 * falls back to the whole set rather than failing: a shot that reached the renderer has
 * already been judged feasible, and rendering it against every photo is worse than
 * routing but far better than rendering it against none.
 */
export function selectPhotos(
  photos: Base64Image[],
  sourcePhotos: number[] | undefined,
): { photos: Base64Image[]; usedIndexes: number[]; routed: boolean } {
  const indexes = (sourcePhotos ?? []).filter((i) => i >= 0 && i < photos.length)
  if (indexes.length === 0) {
    return {
      photos,
      usedIndexes: photos.map((_, i) => i),
      routed: false,
    }
  }
  return {
    photos: indexes.map((i) => photos[i]),
    usedIndexes: indexes,
    routed: true,
  }
}
