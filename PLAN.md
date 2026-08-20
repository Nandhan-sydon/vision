# AI Listing Image Generator — V1 Implementation Plan

## Context

`ai-listing-image-generator-spec.md` (Vishnu → Nandhan) asks for a proof of concept:
upload one product photo, get back Amazon-compliant listing images across 5 slots,
without the user ever writing a raw image prompt. Claude reads the photo, extracts a
structured "Visual DNA" fingerprint, and writes the actual generation prompt; the image
models render it so results can be compared side by side.

**V1 is generation only** — no review, no retry, no pass/fail. The spec is explicit that
this is deliberate: V1 establishes the baseline quality of Claude's first-try prompts,
and V2's review loop is only worth building once we can measure it against that
baseline. Build V1 completely, show Vishnu, stop.

Repo currently holds the spec and a `.env` with all three keys set.

**Decisions already made with the user:** Next.js App Router (deployable, so Vishnu opens
a URL); all three API keys provided; I source the test photos; everything stays on D:.

**Findings that change the spec as written:**

| Spec says | Reality | Action |
|---|---|---|
| `gemini-3-pro-image-preview` | `gemini-3-pro-image` is the current GA ID | Config-driven, use GA ID |
| `gpt-image-1.5` | **API removal 1 Dec 2026**; `gpt-image-2` shipped May 2026 | Test all three (see below) |
| — | Opus 5 thinking is on by default and shares the `max_tokens` budget | `max_tokens: 16000` |
| — | `.env` uses `GEMINI_KEY`, not the SDK-default `GEMINI_API_KEY` | Read explicitly |

### Why a third generator

Spec §6 says this comparison "is what decides" the image vendor. `gpt-image-1.5` has
~3 months of API life left, so deciding between it and Gemini answers the wrong question.
V1 runs `gemini-3-pro-image`, `gpt-image-1.5`, and `gpt-image-2` on the identical
Claude-written prompt. Keeping 1.5 in means the spec's requested comparison is still
delivered intact; adding 2 means the decision survives December.

---

## Architecture

One pipeline, three stages, called once per slot:

```
photo ──► [1] Visual DNA        Claude Opus 5, vision, structured output
             derived ONCE per photo, reused across all 5 slots
                │
                ▼
         [2] Prompt writing     Claude Opus 5, structured output
             DNA + slot rules + optional hint → one final prompt
                │
        ┌───────┼───────┬───────────────┐
        ▼       ▼       ▼               │  same prompt,
   [3a] Gemini  [3b]    [3c]            │  same reference photo,
        3-pro   gpt-    gpt-image-2     │  Promise.allSettled
        image   image-1.5               │
        └───────┴───────┴───────────────┘
                        ▼
              3 images + per-call cost + timings
```

Deriving Visual DNA **once per photo** is not just a cost saving: spec §7 wants the
prompt-writing step and V2's verifier checking against *the same* definition of the
product, not re-deriving it each time. Caching it in V1 puts that invariant in place now.

### Files

```
app/
  page.tsx                  upload, 5 slot tiles, hint box, results
  api/dna/route.ts          POST photo → Visual DNA (once, on upload)
  api/generate/route.ts     POST {dna, slotId, hint, photo} → N images
lib/
  config.ts                 model IDs, cost table, env validation
  slots.ts                  slot registry — the reusability seam
  claude/dna.ts             stage 1
  claude/prompt.ts          stage 2
  claude/system-prompts.ts  the prompt-writer instructions (the core IP)
  generators/types.ts       ImageGenerator interface
  generators/gemini.ts      stage 3a
  generators/openai.ts      stages 3b + 3c (one module, two model IDs)
  storage.ts                disk local / Vercel Blob deployed / no-op
  cost.ts                   Claude token cost + per-image cost
scripts/
  run-batch.ts              full matrix → contact sheet, resumable
  check-compliance.ts       deterministic pixel checks on Main outputs
test-photos/                3–4 sourced product shots
runs/<runId>/               run.json + images, per run
```

### The reusability seam (spec §10)

Everything Amazon-specific is **data** in `lib/slots.ts`. The pipeline knows only a shape:

```ts
type Slot = {
  id: string
  label: string
  mode: 'locked' | 'creative'   // locked = hard rules beat any user hint
  directive: string             // what this slot should show
  hardRules?: string[]          // injected verbatim, non-negotiable
}
```

Slot definitions:

| id | mode | directive | hardRules |
|---|---|---|---|
| `main` | locked | Product alone, centered, straight-on | Pure white background RGB(255,255,255); product fills 85–90% of frame; no props; no text; no watermark; no added logos |
| `angle-2` | creative | Same product rotated — a different side or three-quarter view | — |
| `angle-3` | creative | Another angle, or a close-up on a defining feature | — |
| `lifestyle` | creative | Realistic real-world setting that fits this specific product | — |
| `detail` | creative | Macro/texture close-up on material and craftsmanship | — |

Adding a blog-image pack later is a new array in this file. No function in `claude/` or
`generators/` contains the strings `Amazon` or `listing`.

---

## Stage detail

### 1. Visual DNA — `lib/claude/dna.ts`

Claude Opus 5, photo as a base64 `image` block, `output_config.format` with a schema
mirroring spec §7:

```ts
{
  product: string,
  category: string,
  colors: { name: string, hex: string | null }[],
  logo: { text: string, position: string, color: string, style: string } | null,
  material: string,
  finish: string,
  distinguishingFeatures: string[],
  mustNotChange: string[]        // the "not the same product if altered" list
}
```

`max_tokens: 16000`. Never shown to the user. Returned to the client on upload and passed
into each generate call.

### 2. Prompt writing — `lib/claude/prompt.ts`

Claude Opus 5, structured output:

```ts
{ prompt: string, hintHandling: 'none'|'incorporated'|'partially-overridden'|'rejected' }
```

The system prompt (`lib/claude/system-prompts.ts`) encodes the spec's three governing
rules. Draft:

> You write prompts for an image generation model. You are given a Visual DNA record
> describing a real product, a slot definition, and optionally a short preference typed
> by a user. You return one prompt.
>
> **Visual DNA is inviolable.** Every prompt you write must instruct the generator to
> reproduce the exact logo, colors, shape, proportions, material, and finish recorded in
> the Visual DNA, and must never introduce, remove, or alter anything in `mustNotChange`.
> This holds for every slot and regardless of what the user typed.
>
> **Hard rules beat the user.** If the slot has `hardRules`, they are absolute. Fold them
> into the prompt verbatim in substance. If the user's preference conflicts with a hard
> rule — asking for a colored background, added text, or a prop on a slot that forbids
> them — silently drop the conflicting part. Do not negotiate, do not explain, do not
> mention the conflict in the prompt. Set `hintHandling: 'rejected'`.
>
> **The hint is a preference, never a prompt.** Never pass the user's text through.
> Rewrite it into your own prompt language, correcting anything that would break
> compliance or Visual DNA. If it is compatible, incorporate the intent and set
> `hintHandling: 'incorporated'`. If part survives and part is dropped, use
> `'partially-overridden'`. If no hint was given, use `'none'` and proceed on your own
> judgment.
>
> On creative slots you have real latitude — pick a treatment that suits this specific
> product. Write a single concrete, visual prompt. No preamble, no options, no commentary.

`hintHandling` is logged, never surfaced. It is what lets the report show where hints
were overridden — the data the V1-vs-V2 comparison needs.

### 3. Generators — `lib/generators/`

```ts
interface ImageGenerator {
  id: 'gemini' | 'openai-1-5' | 'openai-2'
  label: string
  generate(prompt: string, refImage: Base64Image): Promise<GenResult>
}
// GenResult = { imageBase64, mimeType, costUsd, ms }
```

- **Gemini** — `POST /v1beta/models/gemini-3-pro-image:generateContent`, reference photo
  as an `inlineData` part alongside the text part. `generateContent` rather than the newer
  `/v1beta/interactions`: Interactions is GA but exists for server-side state,
  persistence, and agents, none of which a stateless one-shot render uses; Google points
  single-shot latency-sensitive work at `generateContent`, which also has the API
  stability guarantee and nearly all the image-to-image sample code. Keep the
  `interactions` shape commented in the same file as the documented alternative.
- **OpenAI** — one module, two exported instances. `client.images.edit({ model, image,
  prompt, size: '1024x1024', quality: 'high' })`, reads `b64_json`.

All generators run under `Promise.allSettled`, so one vendor failing returns the others'
images plus a visible per-vendor error rather than blanking the slot. Retry once on 429
and 5xx with backoff; record every retry in `run.json` (spec §8 asks for rate limits).

Output geometry is held constant across vendors — 1:1, ~1024–2048px — so the comparison
is fair.

### Cost tracking (spec §8)

`lib/cost.ts` accumulates Claude cost from `response.usage` at Opus 5 rates ($5 / $25 per
MTok) plus image cost from a static table:

| Model | Rate |
|---|---|
| `gemini-3-pro-image` | $0.134 per image (1K/2K), $0.24 (4K) |
| `gpt-image-1.5` | $0.133 square high, $0.20 portrait/landscape high |
| `gpt-image-2` | $30/1M image output tokens — compute from returned usage, fall back to ~$0.13 estimate |

Every run writes `runs/<runId>/run.json`: Visual DNA, the written prompt, `hintHandling`,
per-call cost, timings, retries, and any vendor errors. Totals render in the UI so cost
is visible while testing.

Storage is a three-way adapter — local disk in dev, Vercel Blob when
`BLOB_READ_WRITE_TOKEN` is set, no-op otherwise. The UI never depends on it; images
return to the browser as data URLs regardless.

### UI

Deliberately bare, per §10. Upload, a row of 5 tiles, one optional "Any specific
direction? (optional)" box, Generate, a loading state, then results side by side labeled
per vendor. No design work.

The one non-obvious requirement: **a single loading state per slot** no matter how many
generators run behind it. V2's internal retry loop hides behind the same seam (§4 step
10), so the UI must not grow a per-vendor progress notion it will later have to lose.

---

## Build order

0. `git init` (nothing is under version control, and real keys are already on disk —
   the scaffold's `.gitignore` must land before any commit). Set `npm_config_cache` to
   `D:\npm-cache` so the install stays off C:, which is 98% full. Verify with
   `npm config get cache`.
1. Scaffold Next.js + TypeScript in `D:\nandh\Desktop\sydon`. Confirm `.gitignore` covers
   `.env`. No `.env.example` step — keys already exist.
2. `config.ts`, `slots.ts`, `cost.ts` — data and constants first. Validate all three env
   names at startup, reading `GEMINI_KEY` explicitly.
3. `claude/dna.ts` + `/api/dna`. Verify against one photo; inspect the DNA object.
4. `claude/prompt.ts` + `system-prompts.ts`. Verify all 5 slots produce sane prompts,
   plus the adversarial hint case.
5. `generators/gemini.ts` — one live call before building on it.
6. `generators/openai.ts` — both model IDs.
7. `/api/generate` wiring all three in parallel + storage + cost. **Check the Vercel
   duration cap here**, before the UI exists: this route is one Claude call plus three
   image generations, Nano Banana Pro at 2K is slow, and `maxDuration = 300` depends on
   the plan. If capped low, have the browser fire one request per generator while still
   showing a single loading state per slot.
8. `page.tsx`.
9. Source 3–4 test photos: something rigid/simple, something with fine printed detail or
   a logo, something reflective or textured.
10. `scripts/run-batch.ts` — full matrix, concurrency-limited to avoid rate limits,
    resumable from a partial `run.json` so one failure doesn't cost a full re-run.
11. `scripts/check-compliance.ts` — see below.

Steps 3–7 each get a live call before the next is built, so no stage rests on an
unverified assumption about the one below it.

---

## Verification

**Deterministic Main-slot compliance** (`scripts/check-compliance.ts`) — test tooling,
not pipeline code, so V1 stays generation-only. For each Main image, sample the border
pixels and assert RGB(255,255,255), and estimate subject fill as a percentage of frame
against the 85–90% target. This turns the spec's headline compliance requirement into a
number in the report instead of "looks white to me", and it costs nothing per run.

**The hostile-hint test** — the single behavior most likely to be quietly wrong. On the
Main slot, enter *"put it on a red gradient background with a SALE badge"* and confirm:
the image is still pure white, prop-free and text-free; `hintHandling` logs `'rejected'`;
and the written prompt contains no trace of the red gradient or the badge.

**Identity drift** — does the product stay recognizably itself across all 5 slots. This
is the core question V1 exists to answer.

**Three-way vendor comparison** — identical prompt and reference photo across
`gemini-3-pro-image`, `gpt-image-1.5`, and `gpt-image-2`.

**Truncation check** — confirm no Claude response returns
`stop_reason: "max_tokens"` once `max_tokens: 16000` is set.

**Cost** — run total near the spec's $8–15. Expected: 4 photos × 5 slots × 3 generators
= 60 images ≈ $7.80, plus ≈ $0.60 Claude ≈ **$8.40**.

**End to end** — full 5-slot set per test photo through all generators (spec §8),
producing a contact sheet: rows are slots, columns are vendors, source photo in the
header, cost and elapsed time per cell.

## Explicitly not in scope

No review step, no PASS/FAIL verdict, no retry loop, no "needs review" flag, no 3-attempt
cap — all V2 (§4). The pipeline returns DNA and prompt alongside the images specifically
so V2 can slot a verifier in afterward without restructuring, but nothing in V1
anticipates it further than that. The deterministic pixel check is test tooling and does
not gate or alter any output.

No design or polish work (§10). No auth, no database, no multi-user state.

## To raise with Vishnu

1. **`gpt-image-1.5` is EOL 1 Dec 2026.** V1 tests `gpt-image-2` alongside it so the §6
   vendor decision is made on a model that will still exist when it matters.
2. **Test photos** (spec §11) — I'm sourcing 3–4 royalty-free shots unless Vishnu
   supplies them.
3. C: is 98% full (3.3 GB free). Not blocking — the project and npm cache both live on
   D: — but worth clearing independently.
