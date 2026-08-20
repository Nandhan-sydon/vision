/**
 * Build memory — Stage 2 spec §7, the third input to every generative decision.
 *
 * The style grid makes every product on the platform look like it belongs to one platform.
 * Build memory makes every shot of ONE product look like it came from one session.
 *
 * They are not the same problem. The grid is identical for everyone, so it cannot express
 * "the first three shots of this bat were taken on pale oak in window light, and the fourth
 * must match". Nothing else in the pipeline can either: each shot is an independent request
 * to a stateless generator with no knowledge of its siblings, which is exactly why a
 * six-image listing generated shot-by-shot drifts even when every individual prompt is good.
 *
 * So what was already produced is recorded, and fed back in as an input.
 *
 * ## Recorded before the image is judged, not after
 *
 * An entry is written as soon as a shot ships, whether or not it passed review. A shot that
 * shipped flagged is still on the listing and still sets the visual expectation for the next
 * one, so omitting it would have shot four match shot three's *intended* look rather than
 * its actual one.
 *
 * ## Storage
 *
 * Three-way, mirroring lib/storage.ts: disk locally, Vercel Blob when a token is present,
 * and in-memory-only otherwise. The last case is why the API also accepts a caller-supplied
 * memory and returns the updated one — on a deployment with no Blob store the client is the
 * only thing with continuity across requests, and losing memory silently would reintroduce
 * exactly the drift this file exists to prevent.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ShotKind } from './slots'

const MEMORY_DIR = path.join(process.cwd(), 'runs', 'build-memory')

export type BuildEntry = {
  shotId: string
  shotLabel: string
  kind: ShotKind
  /** Style grid selections, so a later shot can be told to match rather than re-derive. */
  lightingId: string
  sceneId?: string
  shadow: string
  /** Whether it cleared review. Recorded because a flagged shot still shipped. */
  passed: boolean
  /** Trimmed — full prompts would make the memory larger than the context it feeds. */
  promptExcerpt: string
  at: string
}

export type BuildMemory = {
  productKey: string
  entries: BuildEntry[]
}

/** Entries kept. Older shots still constrain, but the prompt cannot carry the whole set. */
const MAX_ENTRIES = 12
/** Characters of prompt retained per entry. */
const EXCERPT_CHARS = 220

type Mode = 'disk' | 'blob' | 'none'

function mode(): Mode {
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'blob'
  // Vercel's filesystem is read-only apart from /tmp, so disk only makes sense locally.
  if (!process.env.VERCEL) return 'disk'
  return 'none'
}

export function emptyMemory(productKey: string): BuildMemory {
  return { productKey, entries: [] }
}

export async function loadBuildMemory(productKey: string): Promise<BuildMemory> {
  switch (mode()) {
    case 'disk': {
      try {
        const raw = await readFile(path.join(MEMORY_DIR, `${productKey}.json`), 'utf8')
        return JSON.parse(raw) as BuildMemory
      } catch {
        return emptyMemory(productKey)
      }
    }
    case 'blob': {
      try {
        const { head } = await import('@vercel/blob')
        const meta = await head(`build-memory/${productKey}.json`)
        const res = await fetch(meta.url)
        if (!res.ok) return emptyMemory(productKey)
        return (await res.json()) as BuildMemory
      } catch {
        return emptyMemory(productKey)
      }
    }
    default:
      return emptyMemory(productKey)
  }
}

export async function saveBuildMemory(memory: BuildMemory): Promise<void> {
  const trimmed: BuildMemory = {
    ...memory,
    entries: memory.entries.slice(-MAX_ENTRIES),
  }
  const body = JSON.stringify(trimmed, null, 2)

  switch (mode()) {
    case 'disk': {
      await mkdir(MEMORY_DIR, { recursive: true })
      await writeFile(path.join(MEMORY_DIR, `${memory.productKey}.json`), body)
      return
    }
    case 'blob': {
      const { put } = await import('@vercel/blob')
      await put(`build-memory/${memory.productKey}.json`, body, {
        access: 'public',
        contentType: 'application/json',
        allowOverwrite: true,
      })
      return
    }
    default:
      return
  }
}

/**
 * Add or replace one shot's entry.
 *
 * Replaces by shotId so regenerating a shot updates its record rather than appending a
 * second one — otherwise the memory would tell a later shot to match two different looks
 * for the same slot, and the more times a shot was retried the louder its stale version
 * would be.
 */
export function withEntry(memory: BuildMemory, entry: BuildEntry): BuildMemory {
  const entries = memory.entries.filter((e) => e.shotId !== entry.shotId)
  entries.push({ ...entry, promptExcerpt: entry.promptExcerpt.slice(0, EXCERPT_CHARS) })
  return { ...memory, entries }
}

/**
 * Merge a caller-supplied memory with the stored one.
 *
 * Needed wherever storage is 'none': the client holds the only continuity, but the stored
 * copy may still be ahead if another request wrote it. Later `at` wins per shot, so neither
 * side clobbers the other with a stale entry.
 */
export function mergeMemory(a: BuildMemory, b: BuildMemory): BuildMemory {
  const byShot = new Map<string, BuildEntry>()
  for (const entry of [...a.entries, ...b.entries]) {
    const existing = byShot.get(entry.shotId)
    if (!existing || entry.at > existing.at) byShot.set(entry.shotId, entry)
  }
  return {
    productKey: a.productKey || b.productKey,
    entries: [...byShot.values()].sort((x, y) => x.at.localeCompare(y.at)),
  }
}

/**
 * Build memory as the prompt writer sees it.
 *
 * The current shot is excluded — a regeneration must not be told to match its own previous
 * attempt, which would preserve whatever the reviewer just rejected.
 */
export function renderBuildMemory(
  memory: BuildMemory,
  currentShotId: string,
): string {
  const others = memory.entries.filter((e) => e.shotId !== currentShotId)
  if (!others.length) {
    return 'Nothing has been generated for this product yet. This is the first shot, and it sets the look the rest of the listing will be matched to.'
  }

  const lines = others.map((e) => {
    const bits = [
      `- ${e.shotLabel} (${e.kind}): lighting ${e.lightingId}`,
      e.sceneId ? `, setting ${e.sceneId}` : '',
      `, shadow ${e.shadow}`,
      e.passed ? '' : ' [shipped flagged, did not clear review]',
    ]
    return bits.join('')
  })

  return [
    `${others.length} shot${others.length === 1 ? '' : 's'} already generated for this product:`,
    ...lines,
    '',
    'This shot must look like it came from the same session: the same lighting setup, the same surface and setting family where one applies, the same shadow treatment, and the same colour rendition of the product.',
  ].join('\n')
}
