# AI Listing Image Generator — Spec V2

**Supersedes:** `ai-listing-image-generator-spec.md`
**Basis:** V1 built and measured. Every change below is driven by a measurement or a
published vendor/marketplace rule, cited inline.
**Evidence:** `REPORT.md`, `runs/`

---

## 1. What changed, and why

| V1 spec said | Measured reality | V2 |
|---|---|---|
| One uploaded photo | Pose cannot be synthesised from one photo (4 tests) | **3–4 photos** |
| Fixed 5 slots for every product | A watch and a backpack need different shots | **Per-product shot plan** |
| Prompt the model for compliance | Fill came back 75.3 / 90.5 / 94.5% against one target | **Deterministic post-pass** |
| "Pure white background" | No output was ever exactly 255,255,255 | **Segment + composite** |
| Fill 85–90% | Amazon requires **≥85%, no upper bound** | Corrected |
| — | Amazon accepts `.glb` on listings | **Ship a 3D model too** |
| "Visual DNA" | Trademarked by a live competitor (Nozam) | **Rename required** |

---

## 2. Findings behind those changes

**Pose is not achievable from a single photo.**
- `images.edit` is anchored to the reference composition. Asked for a 40° rotation, returned a pixel-identical frontal view.
- `input_fidelity` was already at its loosest (`'low'`). No lever remained.
- Dropping the reference (`images.generate`) changed viewpoint in 1 of 2 attempts and distorted the product both times — height:width went **0.89 → 0.66**, a 26% squatter object.
- Conclusion: this is architectural, not a prompting problem.

**Identity preservation is the strong result.**
- `edit` route held proportions at **0.89 → 0.91** (2% deviation).
- Reproduced a glaze speck recorded in the product fingerprint.
- The core product risk is not materialising.

**Compliance failures are all deterministic.**
- Frame fill: 75.3 / 90.5 / 94.5% for one stated target.
- Background: every image 4–8/255 off pure white. Amazon's scanner rejects deviations invisible to the eye.
- One output cropped the product at the frame edge — a hard fail.
- None of these need a model to fix.

**Compliance guardrail works.**
- Hostile hint on Main (*"red gradient background with a big SALE badge"*) was silently rejected; nothing leaked into the prompt. Verified against a deliberately-leaked control.

**Resolution ceiling.**
- OpenAI's maximum square output is 1024×1024. Amazon's minimum is 1000px, recommended 2000px+. No way to raise it at generation time.

---

## 3. Revised approach

**Principle: route each shot to the technique that is actually good at it.**

| shot type | technique | fidelity |
|---|---|---|
| Main | real photo → segmented → composited on `#FFFFFF` | 100% real pixels |
| Detail / close-up | crop from the real photo, upscale | 100% real pixels |
| Alternate angles | the seller's other photos, same treatment | 100% real pixels |
| Lifestyle / scene | generative | invention acceptable here |
| Infographic | vector text composited over a real photo | text never generated |
| 3D / AR | reconstructed `.glb` | new listing surface |

**Two rules that follow:**
1. Generation makes **content**. A deterministic pass enforces **compliance**. Never ask one model to do both.
2. Text is **never** generated as pixels. Image models mangle it; vector overlay is exact, editable and localisable.

---

## 4. Pipeline

```
3–4 photos
  └─▶ Product fingerprint      Claude, vision, structured    (once)
        └─▶ Shot plan          Claude — which shots, which photo covers each,
        │                      what is still missing         (once)
        └─▶ Prompt             Claude, per generated shot
              └─▶ Render       generate / crop / composite, per shot type
                    └─▶ Compliance pass   segment → crop → pad → #FFFFFF → upscale
                          └─▶ Output      images + .glb
```

---

## 5. Shot planning

- Claude derives the shot list **per product**. Measured across 4 products: **zero overlap** between lists.
- Each shot carries a **coverage verdict**: which uploaded photo supports it, or which photo the seller still needs.
- Output to the seller is actionable: *"your 4 photos produce 6 of 7 shots; one photo of the base unlocks the seventh."*
- Main is **not** planned. It is a fixed compliance slot with absolute hard rules.
- A shot is never generated from a surface no photo shows. Amazon judges **accuracy, not production method** — an invented base that omits a real maker's stamp is a policy violation, not just poor quality.

**This is the differentiator.** No competitor surveyed offers coverage analysis. Nozam claims *"no hallucinations"* while producing 7 images from 1 photo — which our testing says is not achievable.

---

## 6. Compliance (Amazon, verified)

| rule | requirement |
|---|---|
| Background | **exactly** RGB(255,255,255) |
| Frame fill | **≥85%**, no upper bound |
| Cropping | entire product inside the frame — hard fail |
| Resolution | ≥1000px, 2000px+ recommended |
| Main image | no text, logos, watermarks, props, inset images |

**Implementation — deterministic, no model:**
1. Segment product from background
2. Crop to product bounds
3. Pad to hit the exact target fill
4. Composite on true `#FFFFFF`
5. Upscale past 1024px

Result: fill and background stop being probabilistic. Already proven on V1 output —
**0/2 Amazon-ready as generated → 2/2 after correction**, with product pixels untouched.

---

## 7. 3D / AR

- Amazon accepts `.glb` on listings: **≤200k triangles, ≤1024px textures, ≤5MB**, in home, furniture, electronics, shoes, eyewear.
- Amazon requests **2–10 reference photos** for 3D — the multi-photo flow already supplies them.
- Reconstruction quality improves materially with multi-view input.
- **No render pipeline needed.** Amazon's viewer renders the model; we only deliver it. This removes Blender, HDRI lighting and compositing from scope entirely.
- Optimisation to Amazon's spec runs in Node via `gltf-transform` (uses Sharp, already a dependency).
- Amazon's bar is low relative to model output — we decimate down, not strain up.

**Build vs buy:** API at **$0.05/model** (Hunyuan3D 2.1) versus ~$0.02 self-hosted plus setup and ops. Crossover is tens of thousands of models. **Use the API**, behind a `Reconstructor` interface so it can be swapped later — the same pattern already proven across three image generators.

---

## 8. Cost per listing

4 photos in → 7 images + 1 `.glb` out:

| | |
|---|---|
| Claude (fingerprint + plan + 7 prompts) | $0.29 |
| 7 images @ $0.133 | $0.93 |
| 3D model | $0.05 |
| glTF optimisation | free |
| **Total** | **≈ $1.27** |

Nozam charges **≈ $3.42** for a comparable listing and supplies no 3D model.

**Measured per-image:** GPT Image 1.5 $0.133 / 39s · GPT Image 2 $0.211 / 139s · Gemini ~$0.134 (untested).

---

## 9. Build plan

| # | work | time |
|---|---|---|
| 1 | **Multi-photo** — `Base64Image[]` through the pipeline, multi-upload UI, fingerprint reads all photos, coverage analysis | 1 week |
| 2 | **Compliance pass** — segment, crop, pad, composite, upscale | 1 week |
| 3 | **3D** — `Reconstructor` interface + `gltf-transform` to Amazon spec | 3–4 days |
| 4 | **Infographics** — vector text and callouts over real photos | 1 week |

**≈ 4 weeks.** Each phase ships independently and is separately testable.

---

## 10. Open decisions

1. **Approve the shot plan** replacing the fixed five slots.
2. **Approve 3–4 photos** replacing the single-photo premise.
3. **Rename "Visual DNA"** — trademarked by Nozam, a live competitor.
4. **Confirm positioning.** Feature-matching a funded competitor is weak; accuracy-gating is defensible and aligns with Amazon's actual policy.
5. **Was the original spec derived from Nozam?** Changes whether this is a clone, a competitor build, or coincidence.

---

## 11. Out of scope

- **V2 review-and-retry loop as originally conceived.** It was designed to catch identity drift; drift is largely not happening. What fails is deterministic — framing, cropping, exact white — and is fixed by the compliance pass, not by a model reviewing its own output. Worth re-scoping before building.
- **Self-hosted reconstruction.** Revisit above ~10k models/month.
- **Rendering images from the 3D model.** Multi-photo supplies real pixels; rendering would be strictly worse.
- **Design and polish.** Unchanged from V1.

---

## 12. Status

**Built and verified:** fingerprint, shot plan, prompt writing, hostile-hint rejection, both OpenAI generators, compliance checker, white-point correction, batch runner, contact sheets.

**Built, unverified:** Gemini (free-tier quota is 0 — needs a billed key).

**Spend to date:** ~$4.21.
