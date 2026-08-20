# V1 Report — AI Listing Image Generator

**From:** Nandhan · **To:** Vishnu · **Re:** `ai-listing-image-generator-spec.md`
**Status:** V1 built and tested. Two decisions needed before V2.

---

## Summary

The pipeline works: upload a photo, Claude fingerprints the product, decides which shots
it needs, writes each prompt, and the image models render them. Product identity holds up
remarkably well — better than I expected.

**One thing in the spec turns out not to be achievable.** The Angle 2 and Angle 3 slots
cannot be produced from a single photo. This is not a tuning problem and I could not
prompt around it; four separate tests say the models cannot re-pose a product they have
only seen from one side. Detail below, because it changes what V1 can promise.

Two things also need your decision — both marked **DECISION** below.

---

## 1. What works well

**Identity preservation is the strong result.** The Visual DNA step records the product in
enough detail that the generators reproduce it closely. On the IBM mug it kept the 8-bar
striped wordmark intact — and reproduced a small glaze speck below the logo that Claude
had noted. On the Fossil watch it held the dial text, sub-dials and two-tone bracelet.

Measured: the `edit` route changed the mug's height:width ratio from **0.89 to 0.91** — a
2% deviation. That is the core risk of the whole product, and it is not materialising.

**The compliance guardrail works.** A hostile instruction on the Main slot — *"put it on a
red gradient background with a big SALE badge and some sparkles"* — was silently rejected.
Nothing from it reached the prompt, and the output stayed pure white, prop-free and
text-free. Verified against a deliberately-leaked control prompt so the check itself is
trustworthy.

**Lifestyle and detail shots are genuinely good.** For the mug, the model chose a vintage
IBM System/370 manual and a period keyboard for the desk scene, unprompted.

---

## 2. What does not work: Angle 2 and Angle 3

Both slots returned **the same frontal view as the Main image**, differing only in
background. Not a subtle failure — the images are near-duplicates.

The cause is structural. `images.edit` is anchored to the uploaded photo's composition; it
edits a photograph, it does not re-photograph the object. Producing a side view from a
front-on shot is novel-view synthesis, which is a materially harder problem.

What I tried:

| attempt | result |
|---|---|
| Rewriting the prompt to lead with the rotation | no change |
| `input_fidelity` (the one relevant API control) | already at its loosest setting |
| Dropping the reference photo entirely (text-to-image) | changed viewpoint **once in two tries**, and distorted the product both times |

That last one is the important measurement. On the handle-profile test the product went
from a height:width of **0.89 to 0.66** — a 26% squatter mug. It did not deliver the
requested side view *and* it broke the likeness.

**So the pipeline now asks you to photograph these rather than generating them.** A
recognisably wrong product is worse than a missing image. This is reversible in one config
setting the moment a model can do it.

**Still open:** Gemini has not been tested — the key available was on the free tier, where
Nano Banana Pro has a request quota of zero. It is fully wired and needs only a billed
key. It is the last remaining candidate for pose, and worth ~$3 to settle.

---

## 3. DECISION 1 — the shot list should be per product

The spec fixes five slots for everything. That does not survive contact with real
products: a watch needs a caseback and clasp, a backpack needs straps and patina, a wall
print needs neither.

So Claude now decides the shot list per product. Across four test products the lists had
**zero overlap**:

| mug | watch | backpack | headphones |
|---|---|---|---|
| logo close-up | dial macro | pocket flap | earcup plate |
| handle profile | bezel notching | leather patina | ear cushion |
| interior & rim | crown & pushers | worn on body | folded flat |
| base & maker mark | bracelet clasp | open interior | cable & remote |
| held in hand | caseback | back & straps | case interior |

The reasoning is commercially sound — for the mug it argued *"collectors of IBM
promotional ware use the base mark to date and authenticate the piece."*

Each shot is also marked **derivable from your photo** or **needs a real photograph**. So
instead of inventing a mug base that might omit a genuine maker's stamp — a misleading
listing image, not just a poor one — it tells the seller which photo to take.

**This replaces spec §3.** It costs one extra Claude call per product (~$0.04) and it is
the direct answer to "we can't write instructions for every product." I recommend keeping
it, but it is your call.

---

## 4. DECISION 2 — the one-photo premise

Roughly a quarter of the shots worth taking need a viewpoint the uploaded photo does not
contain. Three options:

1. **Accept fewer generated shots.** Ship what works; ask sellers for the rest. This is
   what the build currently does.
2. **Allow multiple source photos.** `images.edit` accepts an array. Two or three photos
   from different angles would very likely make the angle shots work. Changes the spec's
   premise.
3. **Wait for Gemini.** Unknown until tested.

---

## 5. Amazon compliance — one finding worth acting on

Amazon's real rules differ from the spec's paraphrase:

- Frame fill is **≥85%, no upper bound** — the spec's "85–90%" is tighter than required.
- **Cropping is the hard fail.** One output cut the mug handle off at the frame edge.
- The background must be **exactly RGB(255,255,255)**; Amazon's scanner catches deviations
  invisible to the eye.

**Every image we generated would have been rejected.** All landed 4–8/255 off pure white —
visually perfect, mathematically non-compliant. No prompt fixes this. A deterministic
white-point correction after generation does:

```
0/2 Amazon-ready as generated
2/2 after correction
```

Product pixels are untouched — fill percentages are identical before and after.

Also: **OpenAI's maximum square output is 1024×1024.** Above Amazon's 1000px minimum, below
their 2000px recommendation for zoom, with no way to raise it. Gemini supports 2K and 4K.

---

## 6. Cost

Full 5-slot run, one product, both OpenAI models — 10 images, zero failures:

| | |
|---|---|
| Claude (DNA + prompts) | $0.20 |
| GPT Image 1.5 | $0.68 — 42s average |
| GPT Image 2 | $1.05 — 150s average |
| **Total** | **$1.93** |

Development and testing to date: **~$4.21.**

A full four-product run on planned shots projects to **~$7**, inside the spec's $8–15.

**Per-image:** GPT Image 1.5 $0.133 · GPT Image 2 $0.211 · Gemini ~$0.134 (list).

---

## 7. Vendor comparison so far

| | GPT Image 1.5 | GPT Image 2 |
|---|---|---|
| Speed | **39s** | 139s |
| Cost | **$0.133** | $0.211 |
| Identity | good | **slightly better** |
| Max square | 1024 | 1024 |

GPT Image 2 holds the silhouette closer but costs 1.6× and takes 3.5× as long. **Note
`gpt-image-1.5` is scheduled for API removal on 1 Dec 2026** — which is why I tested its
successor alongside it rather than only the model the spec named.

Gemini is untested and is the only route to Amazon's recommended resolution.

---

## 8. API issues encountered

- **Gemini free tier has a quota of 0** for `gemini-3-pro-image` — every call 429s.
  Needs billing enabled.
- **GPT Image 2 latency is high** (~150s). Combined with prompt writing this exceeds
  common serverless limits, so the pipeline issues one request per generator and the
  browser fans out — the user still sees a single loading state.
- No rate limits hit on OpenAI at 2 concurrent requests. Zero failures across the run.

---

## 9. What I recommend

1. **Enable Gemini billing** (~$3 to settle). It answers the pose question and is the only
   route to 2000px+.
2. **Decide on the shot plan** (§3) and **the one-photo premise** (§4).
3. Then a full four-product run (~$7) once, rather than three times.

**On V2:** the case for the review-and-retry loop is stronger than expected, but for a
different reason than the spec anticipated. Identity drift — the risk V2 was designed to
catch — is largely not happening. What *is* failing is deterministic and measurable:
framing, cropping, and exact-white compliance. Some of that is better fixed by the
post-processing already built than by a model reviewing its own output.

Worth discussing what V2 should actually check before building it.
