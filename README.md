# AI Listing Image Generator

Upload 3–6 photos of a product. Claude reads the product across all of them, decides which
shots *that particular product* needs, works out which photo produces each one, writes every
prompt, and the image models render them. Each render is then reviewed against the seller's
real photos and regenerated if it misses. The user never writes a prompt.

Built to `ai-listing-image-generator-spec.md`, revised by `SPEC-V2.md`. Measurements:
`REPORT.md`, `runs/`.

---

## Pipeline

```
3–6 photos
  └─▶ Product record    Claude, vision, structured — product + COVERAGE MAP   (once)
        └─▶ Shot plan   which shots this product needs, which photo produces each,
        │               and which shots no photo supports                     (once)
        └─▶ per shot ──▶ prompt ──▶ generate ──▶ deterministic correction ──▶ review
                            ▲                                                    │
                            └────────── the reviewer's specific defects ◀────────┘
                                              (up to 3 attempts)
```

Three things carry the weight: the coverage map, the review loop, and the refusal to
generate what no photo shows.

---

## Multiple photos, and why they are the fix rather than a feature

V1's central negative finding was that pose cannot be synthesised. `images.edit` is
structurally anchored to the reference composition — asked for a 40° rotation it returned a
pixel-identical frontal view — and `input_fidelity` was already at its loosest, so no lever
remained. Dropping the reference to move the camera instead distorted the product: the mug's
height:width went **0.89 → 0.66**, a 26% squatter object.

That finding still holds. It stops mattering. With several photos a side view is not a pose
to synthesise; it is a photograph the seller already took, and rendering it is an `edit`
anchored on *that* photo — the route where identity held to 2%.

So the fingerprint's job is no longer only to describe the product. It records **which photo
shows which surface**, and that map is the routing table for everything downstream:

| stage | uses the map to |
|---|---|
| shot plan | propose a shot only where a photo supports it |
| render | hand the generator only the photos for the shot in hand |
| review | compare the candidate against those same photos |

A shot whose surface appears in no photo is **not rendered from an adjacent one**. It comes
back to the seller as a photograph to take, in plain language:

```
GENERATE  Main [catalogue]        ← Photo 1 + Photo 2 + Photo 3
GENERATE  Held in hand [in-use]   ← Photo 1 + Photo 2
GENERATE  Logo close-up [detail]  ← Photo 1 + Photo 2 + Photo 3
DEFER     Inside and rim — no uploaded photo shows the surface this shot needs.
          take: Stand the mug on a table and photograph it from directly above, looking
          straight down into it, so the whole rim and the entire inside are visible.
DEFER     Underside stamp — no uploaded photo shows the surface this shot needs.
          take: Turn the mug upside down and photograph the bottom flat-on, close enough
          to read any writing or stamp.
```

Refusing is the product. Seven images from one photo is only achievable by inventing five of
them, and an invented base that omits a real maker's stamp is a policy violation, not merely
a weak image.

Photos the fingerprint judges unusable — blurred, watermarked, heavily cropped — are dropped
from routing rather than silently used. Verified: given a set including a soft upscaled crop,
the planner used 3 of 4 photos and named the fourth's defect.

### Shot kinds

The plan is not a rotation series. Each shot carries a **kind**, and the kind decides what
the prompt may invent, what invariants are injected, and how strictly the reviewer judges.

| kind | may invent | example |
|---|---|---|
| `catalogue` | nothing | the compliance hero on white |
| `angle` | nothing — the viewpoint comes from a photo | bat spine, bat toe |
| `detail` | nothing — a magnification of a real surface | grip macro, sticker close-up |
| `in-use` | the person, clothing, setting, light | batsman's grip at address |
| `scale` | the reference object, at a truthful size | bat beside a stump |
| `context` | the setting only | bat against nets |
| `packaging` | nothing | the bat's sleeve, if photographed |

`in-use` carries the most invariants (`KIND_RULES` in `lib/slots.ts`) because it is the only
kind where invention is licensed, so it is the only kind that needs the boundary spelled out:
five fingers per hand, a grip a person could actually make, nothing passing through anything,
the branding unobstructed, and the product's geometry untouched. The planner is told to
include an in-use shot wherever the product is something a person handles or wears.

---

## The reviewer

SPEC-V2 §11 put the review loop out of scope, and its reasoning was sound at the time: what
V1 measured failing — frame fill, off-white background, a product cropped at the edge — is
geometric, and is fixed correctly and for free by `lib/postprocess.ts`. No model should be
asked to eyeball a fill percentage.

What changed is the shot list. V1 rendered crops and background swaps, where identity held
to 2%. The set now includes a person gripping the product, a macro on a marking, and
viewpoints drawn from different photos — and those fail in ways no measurement catches.

Measured, on the IBM mug's in-use shot at V1's `input_fidelity: 'low'`: the striped logo came
back **perfect**, and the large squared D-handle came back as a small rounded C-handle, twice.
Handle geometry was on the must-not-change list and was spelled out in the prompt. That image
passes every deterministic check there is, and it is a photograph of a different mug.

### The division of labour is strict

| | judges |
|---|---|
| deterministic | background purity, frame fill, crop, resolution — **computed, then handed to the reviewer as fact** |
| model | likeness, legibility of markings, anatomy, physical plausibility, whether the brief was answered |

The reviewer is explicitly told not to estimate geometry and not to contradict the
measurements. The verdict is then **gated in code** (`gateVerdict`), not by the model: a
blocker defect cannot pass however it scored, a compliance-locked slot cannot pass while the
measured compliance says otherwise, and identity below 75 or brief below 65 cannot pass. A
model that has just written *"the logo reads LARSON; the photographs read LARSEN"* will still
sometimes return an approving verdict.

Seeing the seller's real photos alongside the candidate is the whole mechanism. A reviewer
shown only the candidate can judge whether it is a good photograph; only one shown the
originals can judge whether it is a photograph of the seller's product.

### The correction runs before the review, not after

Every V1 image came back 4–8/255 off pure white — visually perfect, rejected by Amazon's
scanner. A reviewer shown the uncorrected image would report a background defect on every
attempt and spend the whole retry budget asking a generator to do something no generator
does. Correct first; review what correction cannot fix.

### The retry carries defects, not a flag

Regenerating the same prompt is a lottery at $0.133 a ticket. The rewritten prompt names the
wording that was wrong, the grip that was impossible, the viewpoint that came back unchanged.
Default 3 attempts; `reroute-photos` widens the reference set, `needs-new-photo` stops
retrying immediately rather than burning two more generations to reach the same answer.

A shot that never passes still returns its **best-scoring** attempt — not the latest, since
attempts do not monotonically improve — labelled `passed: false` with a sentence for the
seller. Silently shipping the third try as a pass is what would make a review loop worse than
none.

---

## Verification

The reviewer gates what reaches a live listing, so it is tested against cases whose answer is
known in advance — including cases it must **reject**. A reviewer that passes everything and
a reviewer that works are indistinguishable on a run where everything happened to be fine.

```bash
npx tsx scripts/verify-review.ts [slug]        # ~$0.32, no image generation
```

| case | expected | result |
|---|---|---|
| a real macro crop, as a detail shot | pass | **PASS** identity 100 · brief 95 |
| a different product entirely | reject | **RETRY** identity 0, 3 blockers |
| the real product, hue-rotated | reject | **RETRY** identity 8, wrong-marking blocker |
| coloured background on locked Main | reject | **RETRY** rule-violation blocker |

**4/4.** Two of those cost real bugs to reach, and both were the reviewer being right:

- The first control handed back the whole reference frame for an *angle* shot. The reviewer
  rejected it as `duplicate-view` — correctly; the reference frame is not a new angle. A
  control has to be an image that genuinely satisfies the brief it is reviewed against.
- The second control fingerprinted a *single* photo, which correctly put "macro of the logo
  print" on the absent-surfaces list, so the reviewer rejected a macro crop as an invented
  surface — also correctly. That is the multi-photo argument in miniature: from one photo
  there is no candidate that satisfies a detail brief honestly.
- A genuine bug did surface: the review prompt penalised a `detail` shot for matching the
  reference exactly, which is precisely the technique SPEC-V2 §3 prescribes as ideal
  (100% real pixels). `duplicate-view` now applies only where the brief asked for a viewpoint
  the reference does not provide.

```bash
npx tsx scripts/verify-multi-photo.ts <dir>      # coverage + routing, ~$0.18, no images
npx tsx scripts/verify-multi-photo.ts --derive mug-ibm
npx tsx scripts/verify-render-loop.ts --dir <dir> --shot 1 --attempts 2
npx tsx scripts/verify-render-loop.ts --dir <dir> --shot 1 --no-review   # V1 baseline
```

`--derive` builds a photo set by cropping one frame, so the frames are honestly different
framings of one real object with no pixel invented. It exercises coverage routing. It does
**not** exercise the reason multi-photo exists — a crop is not a new camera angle — so the
claim that several real angles remove the pose problem is **still unverified**. It needs a
real multi-view set; point `--dir` at one.

`verify-render-loop` writes every attempt plus its review to `runs/render-loop/`. The loop's
claim is "attempt 1 was rejected for a specific fault and attempt 2 fixed it", and that is
worth nothing unless the two images can be put side by side and the fault looked for by eye.

---

## The `input_fidelity` finding

Found by the review loop, and the clearest evidence that it earns its cost. One product, one
generator, GPT Image 1.5, the in-use shot:

| `input_fidelity` | identity | outcome | cost |
|---|---|---|---|
| `'low'` (V1's setting) | 63 | rejected twice, shipped a failing image | $0.617 |
| `'high'` | 85 | **passed on the first attempt** | $0.289 |

Cost *fell* despite `'high'` billing more input tokens, because the retry it avoids costs far
more than the fidelity does. Confirmed by eye: handle profile, glaze tone, the stepped foot
and a small dark speck on the lower wall all carried through.

V1 chose `'low'` for a good reason — identity was carried by the prompt, and `'high'`
tightened the composition lock without helping enough to justify it. That was measured on
crops and background swaps, where the product stays put. It does not transfer to shots that
re-compose the product into a new scene. **Default is now `'high'`;** `OPENAI_INPUT_FIDELITY=low`
reverts.

Not covered by that measurement: shots where the camera must move, where a tighter lock
should make a duplicate of the reference *more* likely. Those are now routed to a photo
already taken from the viewpoint they need, so the lock works with the pipeline rather than
against it — but that is reasoning, not a measurement.

---

## Amazon compliance

Checked deterministically in `lib/compliance.ts`, against Amazon's published rules rather
than the spec's paraphrase.

| rule | reality |
|---|---|
| Background | **Exactly** RGB(255,255,255). Their scanner catches deviations invisible to the eye. |
| Frame fill | **≥85%, no upper bound.** The spec's "85–90%" is tighter than required. |
| Cropping | Entire product inside the frame. This is the real hard fail. |
| Resolution | 1000px minimum, 2000px+ recommended. |

No generated image was ever exactly white — every one landed 4–8/255 off, and no prompt fixes
that. `lib/postprocess.ts` snaps it: **0/2 Amazon-ready as generated → 2/2 after the snap**,
with fill percentages identical before and after.

OpenAI's maximum square output is 1024×1024 — above the 1000px minimum, below the 2000px
recommendation, with no way to raise it. Gemini supports 2K and 4K.

**Still to come:** the full Amazon listing ruleset, which is task 3 and not yet supplied. The
seam for it is `lib/slots.ts` (rules as data) plus `lib/compliance.ts` (deterministic checks);
`KIND_RULES` is where per-shot-type policy lands.

---

## Status

| Stage | Verified live |
|---|---|
| Product record across a photo set + coverage map | ✅ 4-photo set, unusable photo correctly excluded |
| Shot plan with photo routing | ✅ 7 shots, 5 routed, 3 deferred with plain-language asks |
| In-use shot planning + kind rules | ✅ planned and rendered |
| Prompt writing (mode-, kind- and reference-aware) | ✅ |
| Adversarial hint rejection | ✅ **PASS**, validated against a leak control |
| **Reviewer discrimination** | ✅ **4/4** on known-answer cases |
| **Review → retry → best-attempt loop** | ✅ end to end, both a passing and an exhausted run |
| `input_fidelity` high vs low | ✅ measured, default changed |
| GPT Image 1.5 / GPT Image 2 | ✅ 39s $0.133 / 139s $0.211 |
| Compliance + white-point snap | ✅ 0/2 → 2/2 |
| Multi-photo `images.edit` with several references | ⏳ code path exercised; **novel-angle claim untested** |
| Gemini 3 Pro Image (multi-reference parts) | ⛔ built, never called — free-tier quota is 0 |

Enable Gemini with no code change once billing is on:

```
ENABLED_GENERATORS=gemini,openai-1-5,openai-2
```

---

## Cost

Per shot, with review on, GPT Image 1.5:

| | |
|---|---|
| prompt + generate, passing first attempt | ~$0.29 |
| one retry | ~$0.60 |
| two retries | ~$0.90 |
| review only (no generation) | ~$0.05 |

Fingerprint across 4 photos ~$0.08; shot plan ~$0.10. A 6-shot listing that mostly passes
first time lands near **$1.95**. Review is roughly a 20% premium per attempt and, on the one
case measured, *saved* money by making the first attempt succeed.

`review: false` on `/api/render` (or the UI checkbox) gives V1 behaviour at V1 cost.

---

## Setup

```bash
npm install
```

`.env` in the project root (git-ignored):

```
ANTHROPIC_API_KEY=...
GEMINI_KEY=...                 # GEMINI_API_KEY also accepted
OPENAI_API_KEY=...
ENABLED_GENERATORS=...         # optional; defaults to openai-1-5,openai-2
ALLOW_COMPOSE=true             # optional; attempt shots no photo supports. Off by default.
OPENAI_INPUT_FIDELITY=low      # optional; reverts to V1's setting
```

```bash
npm run dev                    # http://localhost:3000
```

## Scripts

```bash
npx tsx scripts/fetch-test-photos.ts          # (re)download the 4 test photos
npx tsx scripts/verify-dna.ts [photo]         # stage 1, single photo
npx tsx scripts/verify-multi-photo.ts <dir>   # stage 1 + 1.5 across a photo set
npx tsx scripts/verify-shot-plan.ts <slug...> # adaptivity across products
npx tsx scripts/verify-text-pipeline.ts       # record + plan + all prompts, NO images
npx tsx scripts/verify-prompts.ts [slug]      # prompts + the adversarial hint test
npx tsx scripts/verify-review.ts [slug]       # reviewer discrimination, 4 known answers
npx tsx scripts/verify-render-loop.ts --dir <dir>   # the full loop. SPENDS MONEY.
npx tsx scripts/verify-pose-fix.ts [slug]     # edit vs compose, same shot, A/B
npx tsx scripts/verify-generators.ts [id]     # generators, hand-written prompt
npx tsx scripts/run-batch.ts                  # full matrix + contact sheets + summary
npx tsx scripts/check-compliance.ts <dir> --snap
npx tsx scripts/check-leak.ts <prompt.txt>    # re-analyse a saved prompt, free
```

**Cost control.** The product record caches to `runs/dna-cache/`, plans and prompts to their
run folders, so re-analysis is free. `run-batch` is **resumable** — `--run <id>` skips cells
already done. Everything except `verify-render-loop` and `run-batch` costs cents.

---

## Layout

```
app/
  page.tsx              bare UI (spec §10 — no design work)
  api/dna/              photos → product record + coverage map
  api/plan/             record → shots this product needs, each routed to its photos
  api/prompt/           record + slot + hint → prompt   (mode-, kind-, reference-aware)
  api/generate/         prompt → one image, one shot, no review
  api/render/           the full loop: write → generate → correct → review → retry
  api/review/           review one image in isolation (reproducing a verdict)
lib/
  photos.ts             the photo set: validation, 1-based labels, per-shot routing
  config.ts             model IDs, pricing, env validation, input_fidelity
  slots.ts              Main's compliance rules, ShotKind, KIND_RULES, the Slot contract
  render-shot.ts        the render loop
  claude/
    system-prompts.ts   the prompt-writer instructions — the core IP
    dna.ts              stage 1 — product record + coverage map
    shot-plan.ts        stage 1.5 — shot list + photo routing + deferrals
    prompt.ts           stage 2 — writes and rewrites
    review.ts           stage 4 — the reviewer and the code-side verdict gate
  generators/           stage 3, one interface, multi-reference edit + compose per vendor
  compliance.ts         Amazon checks
  postprocess.ts        white-point snap
  hint-leak.ts          did a rejected hint survive into the prompt?
  cost.ts, storage.ts
scripts/
test-photos/            4 products + licence manifest
  sets/<slug>/          multi-photo sets (put real multi-view sets here)
runs/<id>/              images, manifest.json, summary.txt, contact sheets
runs/render-loop/       every attempt + its review, for checking the loop by eye
```

### Adding a generator

Implement `ImageGenerator` (taking `PhotoInput`, so one photo or several), widen `GeneratorId`
in `config.ts`, add a price. Nothing else.

### Reusing this for non-Amazon work (spec §10)

Nothing in `lib/claude/` or `lib/generators/` contains the strings `Amazon` or `listing`. The
domain lives in `lib/slots.ts` as data — `LISTING_SLOTS` and `KIND_RULES` — and in the
planner's and reviewer's briefs, so pointing this at blog imagery means changing the
compliance slot and those briefs, not the pipeline.

---

## Open items

- **The novel-angle claim is unverified.** Everything above about multiple photos removing the
  pose problem is reasoning plus a routing test on derived crops. It needs one real multi-view
  set to become a measurement. This is the biggest outstanding risk.
- **Amazon listing rules (task 3)** not yet supplied.
- **`input_fidelity: 'high'` on angle shots** is unmeasured; see above.
- **"Visual DNA" is still the type name.** SPEC-V2 §10.3 flags it as trademarked by Nozam, a
  live competitor. Left alone deliberately — renaming touches every file and would bury this
  change in churn — but it is a legal item, not a cosmetic one.
- **`gpt-image-2` attempts are capped at 2** in `/api/render`: 3 × ~140s plus reviews does not
  fit a 300s duration cap. Reported in the response as `attemptsCapped` rather than silently.
