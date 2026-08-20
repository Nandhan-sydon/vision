# Backend handover

Stage 2 backend for the AI listing-image generator. No UI work — `app/page.tsx` is a
throwaway V1 harness that still runs but has not been updated for build memory or the
compliance pass. Treat the HTTP routes as the product surface.

Spec: `SPEC-V2.md` plus the Stage 2 sections (§7–§18) supplied 2026-08-20. V1 measurements
that drove several decisions here: `REPORT.md`, `runs/`.

---

## 1. Pipeline

```
2–8 photos
  └─▶ /api/dna     Image DNA + coverage map + Amazon category          (once per product)
        └─▶ /api/plan     shot list, each shot routed to the photos that support it
        │                 + the shots NO photo supports, returned as asks
        └─▶ /api/render   per shot, per generator:
                 write prompt ─▶ generate ─▶ REVIEW ─▶ COMPLIANCE PASS ─▶ output
                      ▲                        │              │
                      └── reviewer's defects ──┘              │
                                        ◀── not released ─────┘
                                   (3 attempts, then best ships flagged)
```

Two rules the whole design rests on:

1. **Generation makes content; a deterministic pass enforces compliance.** Never ask one
   model to do both. V1 measured one prompt yielding 75.3 / 90.5 / 94.5% fill against a
   single stated target, and every output 4–8/255 off pure white.
2. **Nothing unphotographed is ever depicted.** A shot whose surface appears in no uploaded
   photo is returned to the seller as a photograph to take, not generated from an adjacent
   one. §17 requires this; it is also the only defensible differentiator.

---

## 2. Running it

```bash
npm install
npm run dev          # http://localhost:3000
```

`.env` in the project root (git-ignored):

```
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
GEMINI_KEY=...                 # required by validateEnv even though §9 disables Gemini
ENABLED_GENERATORS=openai-1-5  # default. See §9 note in lib/config.ts
OPENAI_INPUT_FIDELITY=low      # optional; reverts a measured default, see §7 below
ALLOW_COMPOSE=true             # optional; attempt shots no photo supports. Off by default.
BLOB_READ_WRITE_TOKEN=...      # optional; enables persistent build memory when deployed
```

`validateEnv()` demands all three API keys at boot rather than per request, so a missing key
fails loudly at start instead of as a confusing 4xx mid-run. Gemini's key is still required
even though §9 switches the vendor off — **worth changing** if you want a single-vendor
deployment to boot without it.

### Test suites, cheapest first

```bash
npx tsx scripts/verify-stage2.ts        # FREE, no API. 48 checks. Run on every change.
npx tsx scripts/verify-claim-check.ts   # ~$0.11   §13, 8 known-answer cases
npx tsx scripts/verify-multi-photo.ts <dir>   # ~$0.18   coverage + routing, no images
npx tsx scripts/verify-review.ts [slug] # ~$0.32   reviewer discrimination, 4 cases
npx tsx scripts/verify-render-loop.ts --dir <dir> --shot 1 --attempts 2   # SPENDS MONEY
```

`verify-multi-photo.ts --derive mug-ibm` builds a photo set by cropping one frame, for when
you have no real multi-view set to hand. See the caveat in §7 below.

---

## 3. HTTP API

All routes: `runtime = 'nodejs'`, `maxDuration = 300`. Photos are always
`[{ imageBase64, mediaType }]`.

### `POST /api/dna`
`{ photos[] }` → `{ dna, advice, unusablePhotos[], cost }`

One call across **all** photos, not one per photo — the coverage map can only be produced by
a pass that sees them together, and every later stage routes on it. Rejects fewer than 2
photos (§2 floor). `dna.photos[]` is guaranteed one entry per supplied photo, in order.

### `POST /api/plan`
`{ dna, includePartial? }` → `{ productSummary, coverageSummary, slots[], deferred[], deferrals[], cost }`

`slots[]` are generable and each carries `sourcePhotos: number[]` (0-based indexes into the
upload). `deferrals[]` carry `requiredPhoto` — plain-language instructions for the seller.
Returns 400 on a pre-multi-photo `dna` missing its coverage map.

### `POST /api/render` ← the main one
```
{ generatorId, dna, slot, photos[], hint?, review?, maxAttempts?, buildMemory?, runId? }
  → { dataUrl, passed, stoppedBecause, sellerNote, attemptsUsed, attemptsCapped,
      bestAttempt, attempts[], buildMemory, productKey, style, costUsd, ms, savedPath }
```
One generator per request; the caller fans out and shows one loading state per shot. The
whole loop is server-side — see §5 for why.

- `passed: false` is §11's **"needs review"** flag. The image is still returned. Do not
  present it as a success; §18 forbids that.
- `stoppedBecause`: `passed` | `not-reviewed` | `exhausted` | `unfixable`.
  `unfixable` means no prompt can reach the fault (normally an unphotographed surface) so
  retrying was abandoned rather than exhausted — surface `sellerNote`.
- `attempts[]` carries every attempt's verdict, scores, defects and compliance figures.
  Images are stripped; only the shipped one is returned.
- **`buildMemory` must be echoed back into the next `/api/render` call.** With no Blob token
  the server keeps nothing between requests and the client is the only continuity. Dropping
  it silently reintroduces the cross-shot drift §7 exists to prevent.
- `attemptsCapped: true` means the requested attempt count was reduced (gpt-image-2 only:
  3 × ~140s plus reviews does not fit 300s).

### `POST /api/claim-check`
`{ texts[] }` → `{ results[], safeTexts[], allClean, droppedCount, cost }`

§13. Render **only** `safeTexts`. Dropped items are absent by construction rather than
present-with-a-flag, so a caller cannot ship one by ignoring a boolean. No override param —
§13 and §18 give the seller no override path.

### `POST /api/review`, `POST /api/prompt`, `POST /api/generate`
Diagnostics, not the main path. `/api/review` re-runs a verdict on a saved image in
isolation; `/api/prompt` shows what the writer produces without paying for an image;
`/api/generate` is a raw single generation with no review or compliance pass — useful for
vendor comparison, where extra attempts would confound the measurement.

---

## 4. Module map

```
lib/
  photos.ts            photo set: §2 floor, 1-based labels vs 0-based indexes, per-shot routing
  product-key.ts       stable product identity (FNV-1a) for style + memory keying
  style-grid.ts        §7 fixed values + bounded lighting/scene palettes + resolveStyle()
  build-memory.ts      §7 third input; disk/Blob/none, merge semantics
  amazon/rules.ts      §14–§17 as data. Consumed by prompt writer, reviewer AND pass
  compliance.ts        measurement only. bgMaxDeviation vs bgMaxDeviationExcludingEdge
  compliance-pass.ts   §12 + §10: segment → crop → pad → composite → upscale → verify
  claim-check.ts       §13: deterministic prefilter + intent judgement + rewrite
  render-shot.ts       the §11→§12 loop
  slots.ts             ShotKind, KIND_RULES, the Slot contract, Main's locked rules
  claude/
    dna.ts             §1 Image DNA + coverage map + amazonCategory
    shot-plan.ts       shot list + photo routing + deferrals
    prompt.ts          §8 writer AND rewriter (one component, deliberately)
    review.ts          §11 reviewer + gateVerdict() code-side gate
    system-prompts.ts  the prompt-writer instructions — the core IP
  generators/          §9 OpenAI; Gemini and gpt-image-2 present but disabled
  postprocess.ts       white-point snap (V1; superseded by compliance-pass for Main)
```

### The §7 three inputs, and where each lives

| input | source | carries |
|---|---|---|
| Image DNA | `claude/dna.ts` | identity — what makes this product *this* product |
| style grid | `style-grid.ts` | platform coherence — identical for every product/seller |
| build memory | `build-memory.ts` | this product's already-shipped shots |

They are separate on purpose and neither substitutes for the other: the DNA knows nothing of
the platform, the grid knows nothing of the product. Collapsing them into one "style prompt"
loses whichever the wording happens to favour. `writePrompt()` resolves all three itself
rather than accepting them as arguments, so a new caller cannot forget one and produce an
undirected prompt that looks fine and drifts.

Lighting and scene are selected by **hashing the product identity**, not chosen by a model
and not random. That is what makes "a shot generated today matches one generated last month"
true rather than aspirational, and it spreads unrelated products across the palette so one
product's scene is never re-skinned for another (§18).

---

## 5. Deviations from the spec, and why

Each of these is a deliberate call. Reverse any of them if you disagree, but read the reason
first — most encode a measurement.

**§11/§12 order is followed; the reviewer's scope is narrowed instead.**
Your order is Render → Review → Compliance. A reviewer shown an uncorrected image reports
"the background is not pure white" on *every* attempt, because no generator outputs
mathematically flat white, and the entire retry budget goes on a fault no retry can fix.
Rather than reorder, the review prompt lists exactly what the downstream pass corrects —
exact white point, fill %, centring, resolution, format — and forbids judging them. What it
*does* judge on a main image is the background's **content**: a coloured or textured
backdrop, a surface under the product, a cast shadow, a border. Those no pass can fix and
every retry can. Your sequence holds, without the wasted retries.

**§14 "exactly #FFFFFF" vs §10 "JPEG" — a real conflict, resolved by measuring what the rule
targets.** A hard product edge in a JPEG rings, in every encoder at every quality. Measured
on a synthetic hard-edged product: 3–7/255 within ~8px of the outline, **0 everywhere else**,
and it does not fall with more encoding rounds. Gating on the unmasked figure meant *no main
image was ever released* — the first run of `verify-stage2.ts` failed exactly this way. So
`ComplianceReport` now reports both:

- `bgMaxDeviation` — every background pixel. Recorded, never gated on.
- `bgMaxDeviationExcludingEdge` — excludes one JPEG MCU around the product. **The release
  gate.** Catches every tint, gradient, grey sweep and stray shadow, which is what §14 is
  about; excludes the format's own ringing, which it is not.

If you decide the unmasked figure must be zero, the only route is PNG for main images, which
contradicts §10. Worth raising with whoever owns the ruleset.

**§9 vendor exclusivity is config, not deletion.** Default `ENABLED_GENERATORS=openai-1-5`.
The Gemini and gpt-image-2 implementations stay behind the `ImageGenerator` interface — they
cost nothing switched off, and deleting working paid-for integrations to enforce a
stage-scoped decision would mean rewriting them verbatim when it is revisited.

**`input_fidelity` default changed from V1's `'low'` to `'high'`.** Measured on the in-use
shot, one product, GPT Image 1.5:

| | identity | outcome | cost |
|---|---|---|---|
| `'low'` | 63 | rejected twice, shipped failing | $0.617 |
| `'high'` | 85 | **passed first attempt** | $0.289 |

Cost *fell* despite `'high'` billing more input tokens, because the avoided retry costs more
than the fidelity. Confirmed by eye: handle profile, glaze tone, stepped foot and a small
dark speck on the lower wall all carried through. `OPENAI_INPUT_FIDELITY=low` reverts.
Not covered: shots where the camera must move, where a tighter lock should make a duplicate
of the reference *more* likely.

**Compliance-pass failure is treated as a failed attempt.** §11 only retries on review FAIL,
but §18 forbids silently shipping a partially-compliant result. If the pass cannot release
the file, its own notes — measurements, the most precise feedback in the loop — go back to the
prompt writer and the shot retries.

**"Visual DNA" renamed to "Image DNA"** throughout, matching your §7/§8 wording. Note
SPEC-V2 §10.3 flags the old name as trademarked by Nozam, a live competitor.

---

## 6. Spec conformance

| § | | status |
|---|---|---|
| 2 | 2-distinct-photo floor | ✅ hard floor in `lib/photos.ts`; §1–6 text not supplied |
| 7 | fixed style grid, bounded palettes, colour grading | ✅ `style-grid.ts`, `compliance-pass.ts` |
| 7 | build memory | ✅ `build-memory.ts`, threaded through `/api/render` |
| 7 | infographic layout grid | ⚠️ **constants only — no renderer.** See §7 below |
| 8 | prompt encodes DNA + grid + memory + Main rules + category | ✅ `prompt.ts`, `system-prompts.ts` |
| 9 | OpenAI gpt-image-1.5 exclusively | ✅ config default |
| 10 | 2000px, 1:1, JPEG, sRGB, ≤10MB, deterministic upscale | ✅ verified offline |
| 11 | review → retry, 3-attempt cap, best-with-flag, per-shot | ✅ verified 4/4 + live |
| 12 | segment, crop, pad, composite, upscale, verify | ✅ verified offline |
| 13 | claim-language check | ✅ verified 8/8 |
| 14 | Main rules, universal | ✅ `amazon/rules.ts`, enforced at 3 stages |
| 15 | secondary rules, 20% overlay ceiling | ✅ rules; ceiling unenforced until the renderer exists |
| 16 | apparel / footwear / jewelry / books / hardgoods | ✅ incl. necklace edge-crop exception |
| 17 | prohibited content | ✅ |
| 18 | never-do list | ✅ |

### Verified vs not

**Verified.** 48/48 offline (style-grid determinism, compliance pass on three fill levels,
§10 output targets, edge rescue, rules, build memory, prefilter, photo floor).
Reviewer 4/4 on known-answer cases. Claim check 8/8. Render loop end to end, both a passing
run and an exhausted-and-flagged run. Coverage routing on a 4-photo set — correctly marked an
upscaled crop unusable and dropped it from routing.

**Not verified — the biggest outstanding risk.** *Everything about multiple real camera
angles removing V1's pose problem is reasoning, not measurement.* The logic: with several
photos a side view is no longer a pose to synthesise but a photograph the seller already
took, so it becomes an `edit` anchored on that photo — the route where identity held to 2%.
That is sound and it is untested, because the repo has no real multi-view set. `--derive`
builds crops of one frame, which tests routing but shares one viewpoint, so it cannot test
this. **Get one real multi-view product set and run `verify-render-loop.ts` against an angle
shot.** Until then, treat the pose claim as unproven.

Also unverified: Gemini has never been called successfully (free-tier quota 0);
`input_fidelity: 'high'` on angle shots; the compliance pass against a real generated image
rather than a synthetic (the loop exercises it, but the offline suite uses synthetics).

---

## 7. Next work, in the order I'd do it

1. **Get a real multi-view photo set** and close the pose question. Everything else is
   downstream of whether that claim holds. Drop it in `test-photos/sets/<slug>/`.
2. **Infographic renderer.** `STYLE_GRID.infographic` has the full fixed template — canvas,
   4 callout positions, font, sizes, line weight, colours, panel opacity, char limits — and
   `/api/claim-check` gates the text. What is missing is the compositor: SVG text panels over
   a real photo via sharp, which is the same technique `compliancePass` already uses. Also
   needs the §15 20%-overlay-area check, computable from the panel geometry before render.
   This is the largest remaining gap and it is well specified.
3. **Drop the Gemini key requirement** from `validateEnv()` so a §9-compliant deployment
   boots with two keys.
4. **Batch orchestration.** `/api/render` is per-shot, per-generator by design (latency), so
   something has to walk a listing's shots and thread `buildMemory` between them. Sequential,
   not parallel — build memory is order-dependent and shot 4 must see shot 3.
5. **Colour grading is unmeasured.** `STYLE_GRID.grading` is deliberately gentle (1.02
   saturation, 1.01 brightness) because anything stronger starts altering product colour,
   which §17 prohibits. Nobody has looked at a graded vs ungraded pair.

---

## 8. Cost

Per shot, GPT Image 1.5, review on:

| | |
|---|---|
| passes first attempt | ~$0.29 |
| one retry | ~$0.60 |
| two retries | ~$0.90 |
| review only | ~$0.05 |
| compliance pass | free (deterministic) |

Per product: Image DNA across 4 photos ~$0.08, shot plan ~$0.10. A 6-shot listing mostly
passing first time lands near **$1.95**. `review: false` gives V1 behaviour at V1 cost.

Total spend building and verifying this: roughly $6.
