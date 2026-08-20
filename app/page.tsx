'use client'

/**
 * Bare-bones PoC UI (spec §10 — no design work).
 *
 * Upload 3-6 photos → Claude reads the product across all of them and decides which shots
 * it needs and which photo produces each → pick one → optional hint → Generate → the render
 * loop writes, generates, corrects, reviews and retries → results side by side.
 *
 * Three deliberate constraints:
 *  - The slot tiles are NOT a fixed list. They come from the per-product shot plan, because
 *    the right shot set is a property of the product.
 *  - The user sees a SINGLE loading state per shot however many generators run behind it,
 *    and however many attempts each one takes.
 *  - What was NOT produced is shown as prominently as what was. A seller who is told
 *    "one photo of the toe unlocks the seventh shot" can act; a seller handed seven images,
 *    two of them invented, cannot.
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import type { ImageDNA } from '@/lib/claude/dna'
import type { Slot } from '@/lib/slots'
import type { PlannedShot } from '@/lib/claude/shot-plan'

/**
 * Six photos at 1536px would put ~4MB of base64 in a single request body. 1280 keeps a
 * full set comfortably inside platform limits while staying well above what the generators
 * consume — they render at 1024 square, so the reference is downsampled either way.
 */
const MAX_EDGE = 1280
const MAX_PHOTOS = 8
/** Stage 2 spec §2. A hard floor — the server rejects fewer, and it is right to. */
const MIN_PHOTOS = 2

type Defect = {
  kind: string
  severity: string
  description: string
  evidence: string
}

type AttemptView = {
  n: number
  verdict: string | null
  scores: { identity: number; brief: number; realism: number } | null
  defects: Defect[]
  referenceIndexes: number[]
  compliance?: {
    released: boolean
    width: number
    height: number
    bytes: number
    fillLinearPct?: number
    bgMaxDeviation?: number
    actions: string[]
    notes: string[]
  } | null
  costUsd?: number
  ms?: number
}

type BuildMemory = { productKey: string; entries: unknown[] }

type GenOutcome = {
  id: string
  label: string
  dataUrl?: string
  error?: string
  costUsd?: number
  ms?: number
  buildMemory?: BuildMemory
  style?: { lighting: string; scene: string | null; shadow: string }
  passed?: boolean
  stoppedBecause?: string
  sellerNote?: string
  attemptsUsed?: number
  attemptsCapped?: boolean
  bestAttempt?: number
  attempts?: AttemptView[]
  promptUsed?: string
  hintHandling?: string
}

type SlotState = {
  status: 'working' | 'done'
  results?: GenOutcome[]
  error?: string
}

type Photo = { data: string; mediaType: string; preview: string; name: string }

/** Downscale in the browser so the request body stays well inside platform limits. */
async function toDownscaledBase64(file: File): Promise<Photo> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas unavailable in this browser.')
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92)
  return {
    data: dataUrl.split(',')[1],
    mediaType: 'image/jpeg',
    preview: dataUrl,
    name: file.name,
  }
}

export default function Page() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [dna, setDna] = useState<ImageDNA | null>(null)
  const [summary, setSummary] = useState('')
  const [coverage, setCoverage] = useState('')
  const [advice, setAdvice] = useState('')
  const [slots, setSlots] = useState<Slot[]>([])
  const [deferrals, setDeferrals] = useState<
    { id: string; label: string; reason: string; requiredPhoto: string }[]
  >([])
  const [deferred, setDeferred] = useState<PlannedShot[]>([])
  const [phase, setPhase] = useState<'idle' | 'reading' | 'planning' | 'ready' | 'error'>(
    'idle',
  )
  const [error, setError] = useState<string | null>(null)

  const [activeSlot, setActiveSlot] = useState('')
  const [hint, setHint] = useState('')
  const [reviewOn, setReviewOn] = useState(true)
  const [runs, setRuns] = useState<Record<string, SlotState>>({})
  const [showDna, setShowDna] = useState(false)
  /**
   * Spec §7, third input. Held here and posted with every render so shots generated in one
   * sitting match each other even when the server keeps nothing between requests.
   */
  const [buildMemory, setBuildMemory] = useState<BuildMemory | null>(null)

  const runId = useRef(
    `${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '')}-ui`,
  )

  const totalCost = useMemo(() => {
    let sum = 0
    for (const s of Object.values(runs)) {
      for (const r of s.results ?? []) sum += r.costUsd ?? 0
    }
    return sum
  }, [runs])

  const analyse = useCallback(async (files: File[]) => {
    setPhase('reading')
    setError(null)
    setDna(null)
    setSlots([])
    setDeferred([])
    setDeferrals([])
    setRuns({})
    setSummary('')
    setCoverage('')
    setAdvice('')
    setBuildMemory(null)

    try {
      if (files.length < MIN_PHOTOS) {
        throw new Error(
          `${files.length} photo selected. Choose at least ${MIN_PHOTOS} photos of the ` +
            'product from different angles — a single photo leaves every surface it does not ' +
            'show unverifiable, so the shots that matter get deferred back to you.',
        )
      }
      const imgs = await Promise.all(files.slice(0, MAX_PHOTOS).map(toDownscaledBase64))
      setPhotos(imgs)

      const dnaRes = await fetch('/api/dna', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          photos: imgs.map((p) => ({ imageBase64: p.data, mediaType: p.mediaType })),
        }),
      })
      const dnaJson = await dnaRes.json()
      if (!dnaRes.ok) throw new Error(dnaJson.error ?? `HTTP ${dnaRes.status}`)
      setDna(dnaJson.dna)
      setAdvice(dnaJson.advice ?? '')

      setPhase('planning')
      const planRes = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dna: dnaJson.dna }),
      })
      const planJson = await planRes.json()
      if (!planRes.ok) throw new Error(planJson.error ?? `HTTP ${planRes.status}`)

      setSummary(planJson.productSummary)
      setCoverage(planJson.coverageSummary ?? '')
      setSlots(planJson.slots)
      setDeferred(planJson.deferred ?? [])
      setDeferrals(planJson.deferrals ?? [])
      setActiveSlot(planJson.slots[0]?.id ?? '')
      setPhase('ready')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }, [])

  const generate = useCallback(async () => {
    const slot = slots.find((s) => s.id === activeSlot)
    if (!photos.length || !dna || !slot) return
    setRuns((r) => ({ ...r, [slot.id]: { status: 'working' } }))

    try {
      // One request per generator, each running the full write → generate → correct →
      // review → retry loop server-side. The browser only waits.
      const generatorIds: string[] = await fetch('/api/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dna, slot, hint: hint.trim() || undefined }),
      })
        .then((r) => r.json())
        .then((j) => j.generators ?? [])

      const payloadPhotos = photos.map((p) => ({
        imageBase64: p.data,
        mediaType: p.mediaType,
      }))

      const results = await Promise.all(
        generatorIds.map(async (generatorId): Promise<GenOutcome> => {
          try {
            const res = await fetch('/api/render', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                generatorId,
                dna,
                slot,
                photos: payloadPhotos,
                hint: hint.trim() || undefined,
                review: reviewOn,
                buildMemory: buildMemory ?? undefined,
                runId: runId.current,
              }),
            })
            return (await res.json()) as GenOutcome
          } catch (err) {
            return {
              id: generatorId,
              label: generatorId,
              error: err instanceof Error ? err.message : String(err),
            }
          }
        }),
      )

      // Carry the updated memory forward. Last writer wins across the generator fan-out;
      // they render the same shot, so their entries for it are equivalent.
      const returned = results.find((r) => r.buildMemory)?.buildMemory
      if (returned) setBuildMemory(returned)

      setRuns((r) => ({ ...r, [slot.id]: { status: 'done', results } }))
    } catch (err) {
      setRuns((r) => ({
        ...r,
        [slot.id]: {
          status: 'done',
          error: err instanceof Error ? err.message : String(err),
        },
      }))
    }
  }, [photos, dna, activeSlot, hint, slots, reviewOn, buildMemory])

  const active = runs[activeSlot]
  const busy = active?.status === 'working'
  const activeSlotDef = slots.find((s) => s.id === activeSlot)

  return (
    <main className="wrap">
      <h1>AI Listing Image Generator</h1>
      <p className="sub">
        Upload 3–6 photos of the product from different angles (at least {MIN_PHOTOS}).
        Claude reads the product across all of them, works out which shots this item needs and
        which photo produces each, writes every prompt against the platform style grid, reviews
        each image against your real photos, regenerates the ones that miss, and puts every
        release through a deterministic marketplace-compliance pass. You never write a prompt.
      </p>

      <section className="card">
        <h2>1. Product photos</h2>
        <input
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? [])
            if (files.length) void analyse(files)
          }}
        />
        <p className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          At least {MIN_PHOTOS} photos, and more angles means fewer invented surfaces. A shot
          nothing shows is handed back to you as a photo to take, not guessed at.
        </p>

        {photos.length > 0 && (
          <>
            <div className="tiles" style={{ marginTop: 12 }}>
              {photos.map((p, i) => {
                const role = dna?.photos.find((r) => r.index === i)
                return (
                  <figure key={i} style={{ width: 150 }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={p.preview} alt={`uploaded ${i + 1}`} className="thumb" />
                    <figcaption>
                      <strong>Photo {i + 1}</strong>
                      {role && (
                        <>
                          <br />
                          {role.viewpoint}
                          {!role.usable && (
                            <>
                              <br />
                              <span className="err">unusable: {role.issue}</span>
                            </>
                          )}
                        </>
                      )}
                    </figcaption>
                  </figure>
                )
              })}
            </div>

            {phase === 'reading' && <p className="muted">Reading the product…</p>}
            {phase === 'planning' && (
              <p className="muted">Deciding which shots this product needs…</p>
            )}
            {phase === 'error' && <p className="err">{error}</p>}
            {phase === 'ready' && dna && (
              <>
                <p className="ok">
                  <strong>{dna.product}</strong>{' '}
                  <span className="muted">· {dna.amazonCategory} rules</span>
                </p>
                <p className="muted">{summary}</p>
                {advice && <p className="muted">{advice}</p>}
                <button className="link" onClick={() => setShowDna((v) => !v)}>
                  {showDna ? 'hide' : 'show'} internal product record
                </button>
                {showDna && <pre className="pre">{JSON.stringify(dna, null, 2)}</pre>}
              </>
            )}
          </>
        )}
      </section>

      {phase === 'ready' && (
        <>
          <section className="card">
            <h2>2. Shots for this product</h2>
            {coverage && <p className="muted" style={{ marginBottom: 12 }}>{coverage}</p>}

            <div className="tiles">
              {slots.map((slot) => {
                const st = runs[slot.id]
                const from = slot.sourcePhotos?.length
                  ? `from photo ${slot.sourcePhotos.map((i) => i + 1).join(', ')}`
                  : 'no photo'
                return (
                  <button
                    key={slot.id}
                    onClick={() => setActiveSlot(slot.id)}
                    className={`tile${slot.id === activeSlot ? ' on' : ''}`}
                    disabled={busy}
                  >
                    <span>{slot.label}</span>
                    <small>
                      {st?.status === 'working'
                        ? 'generating…'
                        : st?.status === 'done'
                          ? `${st.results?.filter((r) => r.dataUrl).length ?? 0} image(s)`
                          : from}
                    </small>
                  </button>
                )
              })}
            </div>

            {deferrals.length > 0 && (
              <div className="note">
                <strong>Worth photographing yourself</strong> — these would help this
                product, but no photo you uploaded shows what they need, so generating them
                would mean inventing detail that may not match the real item:
                <ul>
                  {deferrals.map((d) => {
                    const shot = deferred.find((s) => s.id === d.id)
                    return (
                      <li key={d.id}>
                        <strong>{d.label}</strong> — {shot?.rationale ?? d.reason}
                        {d.requiredPhoto && (
                          <>
                            <br />
                            <em>Take: {d.requiredPhoto}</em>
                          </>
                        )}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            <label className="lbl" htmlFor="hint">
              Any specific direction? (optional)
            </label>
            <input
              id="hint"
              value={hint}
              onChange={(e) => setHint(e.target.value)}
              placeholder="e.g. show it on a marble countertop"
              disabled={busy}
            />

            <label className="lbl" style={{ marginBottom: 12 }}>
              <input
                type="checkbox"
                checked={reviewOn}
                onChange={(e) => setReviewOn(e.target.checked)}
                disabled={busy}
              />{' '}
              Review each image against my photos and regenerate if it misses (slower,
              costs more per shot)
            </label>

            <button
              className="go"
              onClick={() => void generate()}
              disabled={busy || !activeSlot}
            >
              {busy ? 'Generating your image…' : 'Generate'}
            </button>
            {busy && reviewOn && (
              <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
                Each attempt is generated, corrected, then checked against your photos. A
                rejected image is regenerated with the specific fault named, so this can
                take a few minutes.
              </p>
            )}
          </section>

          <section className="card">
            <h2>3. Result{activeSlotDef ? ` — ${activeSlotDef.label}` : ''}</h2>
            {!active && <p className="muted">Nothing generated for this shot yet.</p>}
            {active?.status === 'working' && <p className="muted">Generating your image…</p>}
            {active?.error && <p className="err">{active.error}</p>}
            {active?.status === 'done' && active.results && (
              <div className="grid">
                {active.results.map((r) => (
                  <figure key={r.id}>
                    {r.dataUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={r.dataUrl} alt={`${r.label} output`} />
                    ) : (
                      <div className="fail">{r.error ?? 'no image'}</div>
                    )}
                    <figcaption>
                      <strong>{r.label}</strong>
                      {r.ms != null && <> · {(r.ms / 1000).toFixed(0)}s</>}
                      {r.costUsd != null && <> · ${r.costUsd.toFixed(3)}</>}
                      {r.attemptsUsed != null && (
                        <>
                          {' '}
                          · {r.attemptsUsed} attempt{r.attemptsUsed === 1 ? '' : 's'}
                        </>
                      )}
                      {r.dataUrl && r.passed === false && (
                        <>
                          <br />
                          <span className="err">
                            {r.stoppedBecause === 'unfixable'
                              ? 'Not produced honestly from your photos — see below.'
                              : 'Best of the attempts; still not fully passing review.'}
                          </span>
                        </>
                      )}
                      {r.sellerNote && (
                        <>
                          <br />
                          <em>{r.sellerNote}</em>
                        </>
                      )}
                      <ReviewTrail outcome={r} />
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <footer className="foot">
        run <code>{runId.current}</code> · total ${totalCost.toFixed(3)}
      </footer>
    </main>
  )
}

/**
 * What the reviewer said, per attempt.
 *
 * Collapsed by default and shown in full on demand rather than summarised away: the review
 * is the reason an image was kept or thrown out, and a loop whose reasoning cannot be read
 * is one nobody can tell is working. This is also where a wrong verdict becomes visible.
 */
function ReviewTrail({ outcome }: { outcome: GenOutcome }) {
  if (!outcome.attempts?.length) return null

  return (
    <details className="det">
      <summary>
        review trail{outcome.attemptsCapped ? ' (attempts capped for this generator)' : ''}
      </summary>
      {outcome.attempts.map((a) => (
        <div key={a.n} style={{ marginTop: 8 }}>
          <strong>
            Attempt {a.n}
            {a.n === outcome.bestAttempt ? ' — shipped' : ''}
          </strong>{' '}
          {a.verdict ?? 'not reviewed'}
          {a.scores && (
            <>
              {' '}
              · identity {a.scores.identity} · brief {a.scores.brief} · realism{' '}
              {a.scores.realism}
            </>
          )}
          {a.referenceIndexes?.length > 0 && (
            <>
              {' '}
              · from photo {a.referenceIndexes.map((i) => i + 1).join(', ')}
            </>
          )}
          {a.defects.length > 0 && (
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {a.defects.map((d, i) => (
                <li key={i}>
                  <strong>{d.severity}</strong> · {d.kind} — {d.description}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
      {outcome.promptUsed && (
        <>
          <p className="muted" style={{ marginTop: 8 }}>
            prompt used (hint: {outcome.hintHandling}):
          </p>
          <pre className="pre">{outcome.promptUsed}</pre>
        </>
      )}
    </details>
  )
}
