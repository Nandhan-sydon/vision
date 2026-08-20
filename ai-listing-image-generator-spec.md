# AI Listing Image Generator — PoC Spec

**For:** Nandhan
**From:** Vishnu
**Status:** Proof of concept — not a production build
**Last updated:** August 11, 2026

---

## 1. Objective

Prove that we can take one uploaded product photo and automatically generate multiple Amazon-compliant, realistic listing images from it — without the user ever writing a raw prompt themselves. The user can optionally type a short preference/direction, but Claude always rewrites and improves it into the actual prompt — the user never controls the image generator directly.

Claude writes the prompts, Gemini and ChatGPT generate the images. In a later version, Claude also reviews its own output and retries if something's wrong. The user just uploads a photo, clicks a slot, optionally types a hint, and waits for the image.

This is being built in two versions on purpose — see Section 4. **Build V1 first. Do not start V2 until V1 is working and we've reviewed the results together.**

---

## 2. User-Facing Flow

This is everything the user sees and does. Nothing else.

1. Upload one product photo
2. See a row of slots: **Main, Angle 2, Angle 3, Lifestyle, Detail**
3. Click a slot
4. **Optional:** a small text box — "Any specific direction? (optional)" — user can type something like "show it on a marble countertop" or leave it blank
5. Click Generate
6. See a loading/waiting state ("Generating your image...")
7. Final image appears in that slot
8. Repeat for other slots

**The text box is optional, not required, and it is not a prompt box in the traditional sense.** The user is never writing the actual prompt sent to the image generator — they're giving Claude a hint or preference, in plain language. Claude takes whatever the user typed (if anything) and folds it into the proper, rule-compliant, Visual-DNA-safe prompt it writes. If the user leaves it blank, Claude proceeds exactly as before, using its own judgment.

---

## 3. Slots to Build (5 total)

| Slot | What it should show |
|---|---|
| **Main** | Pure white background (RGB 255,255,255), product centered, filling 85-90% of the frame, no props, no text, no watermark |
| **Angle 2** | Same product, different rotation or side view |
| **Angle 3** | Same product, another angle or a close-up on a defining feature |
| **Lifestyle** | Product placed in a realistic real-world setting — Claude decides what setting fits this specific product |
| **Detail** | Macro/texture close-up highlighting material and craftsmanship |

---

## 4. Version Plan

### Version 1 — Generation only (build this first)

No review, no retry, no pass/fail check. Just: Claude thinks, Gemini makes, done.

```
1. User uploads product photo
2. User clicks a slot
3. Claude looks at the photo and identifies:
   - what the product is
   - category
   - colors (exact color names or hex if identifiable)
   - logo/branding (text, position, color, style)
   - material and texture
   - distinguishing features
   This is the "Visual DNA" reference — a structured internal note,
   not shown to the user.
4. Claude writes a specific, creative prompt for that product and slot.
   - If the user typed an optional instruction, Claude treats it as a
     preference to incorporate, not a literal prompt to pass through —
     Claude rewrites/improves it, corrects anything that would break
     compliance or Visual DNA, and folds the user's intent into the
     proper structured prompt
   - If the user left it blank, Claude proceeds using its own judgment,
     same as before
   - For Main: bake in Amazon's rules directly into the prompt
     (pure white 255,255,255 background, product fills 85-90% of frame,
     no props, no text, no watermark) — this applies even if the user's
     optional instruction conflicts with it (e.g. if someone types "add
     a colorful background" for the Main slot, Claude does not comply,
     since Main must stay compliant regardless of user input)
   - For Angle 2 / Angle 3 / Lifestyle / Detail: Claude has creative
     freedom to pick a realistic, relevant treatment for this specific
     product, informed by the user's optional input if given
   - The prompt must explicitly instruct the image generator to
     preserve the Visual DNA (exact logo, color, shape, proportions)
     from the reference photo, regardless of what the user typed
5. Send Claude's prompt + the original reference photo to BOTH:
   - Gemini (model: gemini-3-pro-image-preview, aka Nano Banana Pro)
   - ChatGPT (model: gpt-image-1.5)
   Same prompt, both generators, so results are directly comparable.
6. Each generator returns an image
7. Show both images to the user (or save both for comparison). No
   check. No retry. Whatever comes back is what's shown.
```

**What V1 is meant to answer:** Can Claude reliably write prompts that produce good results on the first try, with no safety net? This tells us the baseline quality before we add any correction logic.

### Version 2 — Add review + retry (build only after V1 is tested)

Same as V1, plus a check-and-fix loop after image generation:

```
7. Claude reviews the generated image. It receives:
   - the original source photo
   - the newly generated image
   - the Visual DNA reference from step 3
   And checks:
   a) Visual DNA match — same color, same logo, same shape/proportions
      as the source photo?
   b) Slot rules — for Main: is the background actually pure white,
      is the product properly framed, are there any stray props/text/
      watermarks? For other slots: does it follow what was asked?
   c) General quality — does it look realistic, or warped/fake/
      AI-plastic?
8. Claude returns a verdict: PASS or FAIL, with a specific reason if FAIL
9. If PASS → show the image to the user, done.
   If FAIL → Claude rewrites the prompt, specifically correcting the
   flagged issue (e.g. "the logo color drifted, regenerate keeping the
   exact blue from the reference" or "background isn't pure white,
   regenerate with true white background"), then repeat from step 5.
   Cap this loop at 3 total attempts. If still failing after 3, show
   the best attempt with a "needs review" flag instead of looping forever.
   Run this review + retry loop independently for each generator's
   output (Gemini's image and ChatGPT's image are each checked and
   retried on their own).
10. The user still only sees ONE loading state throughout this entire
    loop, no matter how many attempts happened internally.
```

**What V2 is meant to answer:** Does the review loop meaningfully improve quality over V1's raw output? Compare V1 vs V2 results on the same test products once both exist.

---

## 5. APIs Needed

### Google Gemini API
- Model: `gemini-3-pro-image-preview` (Nano Banana Pro)
- Key from Google AI Studio (aistudio.google.com)
- **Must support image-to-image generation** (accepting a reference photo as input, not text-to-image only) — this is required, don't substitute a model that can't do this
- Docs: https://ai.google.dev/gemini-api/docs/image-generation

### OpenAI API (for comparison testing only — see Section 6)
- Model: `gpt-image-1.5`
- Key from OpenAI platform
- Also supports reference image input for editing

### Anthropic (Claude) API
- Needs vision support (able to receive images as part of a message)
- Use the latest available Claude model with vision capability
- This is the model doing the prompt-writing (V1 and V2) and the review/retry logic (V2 only)

---

## 6. Model Comparison Testing

Run the same Claude-written prompt through **both** Gemini and ChatGPT for every test image, so results are directly comparable — same prompt, different generator, side by side.

We are not committing to one image generation vendor yet. This test is what decides that.

---

## 7. What "Visual DNA" Means, Concretely

Claude should produce something like this internally as part of step 3 (V1) — doesn't need to be shown to the user, just used by the pipeline:

```
Product: [what it is]
Colors: [exact colors / hex if identifiable]
Logo/branding: [text, position, color, style]
Material/texture: [wood / plastic / fabric / metal, finish]
Distinguishing features: [anything unique that must not change]
Must not change: [the specific list of things that would make this
                   "not the same product" if altered]
```

This same reference gets used in both the prompt-writing step and (in V2) the verification step, so both are checking against the same definition of "the real product," not re-deriving it separately each time.

---

## 8. Testing Instructions

- Use 3-4 different product photos, ideally different categories (e.g. something rigid/simple, something with fine printed detail or logo, something reflective or textured)
- Run the full 5-slot set for each product, through both generators (Gemini and ChatGPT), every time
- For V2 (once built): compare against the V1 results on the same products, same generators

### What to report back
- Source photo + all 5 generated slots, for each test product, from both generators
- Your honest read: does the product identity hold up across slots, or does it drift?
- (V2 only) How many retry loops it took per image — did Claude catch real problems, or is it too strict / too lenient?
- (V2 only) Any case where Claude's PASS/FAIL verdict disagreed with what you'd conclude just by looking — these disagreements are the most useful data point
- Total cost for the test run, broken down by Gemini cost / ChatGPT cost / Claude cost
- Any API issues, rate limits, or unexpected behavior

---

## 9. Rough Cost Expectations (for reference, not a hard budget)

- Per image (Claude fingerprint + prompt + generation, no retries): roughly $0.15-0.20 on Gemini, $0.10-0.20 on ChatGPT
- Full test run (3-4 products × 5 slots × 2 generators): roughly $8-15 total
- This is a small, disposable test cost — don't optimize for cost at this stage, optimize for getting a clear answer on quality

---

## 10. Important Notes

- **UI does not matter right now.** Don't spend any time on design or polish. A bare-bones page is completely fine — the row of slots and a working upload/generate button is enough. Strictly focus on whether the backend pipeline works end-to-end.
- **If it works as expected, we'll think about UI and polish later.** That is a separate, future conversation.
- **Once V1 is working, show it to Vishnu first.** Let Vishnu and the team use it before anything else happens with it.
- **Build V1 completely before starting V2.** Don't blend them or jump ahead — we want a clean before/after comparison.
- **Keep the code reasonably reusable, not hardcoded only for listing slots.** If this pipeline (upload → Claude writes prompt → generate → Claude verifies) works well, it will also help with blog image creation later. Avoid tightly coupling the logic to "Amazon listing slots" specifically where it's easy not to.
- **The optional user instruction box never overrides compliance or Visual DNA.** Claude always has final say on the actual prompt sent to the image generator. If a user's typed instruction would break Main image compliance (e.g. asking for a colored background, added text, or a prop) or would risk changing the product's actual look, Claude ignores that part of the instruction and proceeds compliantly — it does not need to explain this to the user, it just writes a safe prompt regardless of what was typed.

---

## 11. Open Questions (flag if unclear before starting)

- Test product photos: will these be provided, or should Nandhan source his own for testing?
- Confirm who owns/provides the Gemini and OpenAI API keys and billing before starting, so this isn't a blocker mid-build.
