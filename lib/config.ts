/**
 * Model IDs, pricing, and environment validation.
 *
 * Every model ID lives here so a vendor rename is a one-line change. The spec named
 * `gemini-3-pro-image-preview`; Google has since dropped the `-preview` suffix.
 */

export const MODELS = {
  /** Prompt writer + Visual DNA extractor. Vision + structured outputs. */
  claude: 'claude-opus-5',
  /** Nano Banana Pro. Spec said `gemini-3-pro-image-preview`; that alias is superseded. */
  gemini: 'gemini-3-pro-image',
  /** Named in the spec. NOTE: scheduled for API removal 2026-12-01. */
  openai15: 'gpt-image-1.5',
  /** Successor to 1.5, on the API since May 2026. Tested so the vendor choice outlives December. */
  openai2: 'gpt-image-2',
} as const

/**
 * Claude Opus 5 runs thinking ON by default, and `max_tokens` caps thinking AND the
 * response together. Sizing this to just the expected JSON truncates mid-thinking and
 * returns nothing parseable — while looking like a schema or SDK bug. Keep the headroom.
 */
export const CLAUDE_MAX_TOKENS = 16000

/** Held constant across vendors so the side-by-side comparison is fair. */
export const IMAGE_SIZE = {
  gemini: { aspectRatio: '1:1', imageSize: '2K' },
  openai: '1024x1024',
  openaiQuality: 'high',
} as const

/**
 * How tightly `images.edit` is bound to the reference photographs.
 *
 * V1 set this to 'low' and recorded why: identity was carried by the prompt's Visual DNA
 * detail, and 'high' tightened the composition lock without helping identity enough to
 * justify it. That was measured on crops and background swaps, where the product stays put
 * and a tight composition lock is what you want anyway.
 *
 * Re-measured once the shot list included shots that re-compose the product into a new
 * scene, and the earlier conclusion did not hold. On an in-use render of the IBM mug —
 * product held in a hand, one product, one generator, GPT Image 1.5:
 *
 *   input_fidelity 'low'   identity 63, rejected twice, shipped a failing image.  $0.617
 *                          The large squared D-handle came back as a small rounded
 *                          C-handle both times, while the striped logo was reproduced
 *                          perfectly. Handle geometry was on the must-not-change list and
 *                          was spelled out in the prompt, so what was lost was the
 *                          reference binding, not the wording.
 *   input_fidelity 'high'  identity 85, passed on the first attempt.              $0.289
 *                          Handle profile, glaze tone, the stepped foot and a small dark
 *                          speck on the lower wall all carried through.
 *
 * Cost fell despite 'high' billing more input tokens, because the retry it avoided costs
 * far more than the fidelity does. So 'high' is now the default.
 *
 * What that measurement does NOT cover: shots where the camera has to move. A tighter
 * reference lock should make a duplicate of the reference MORE likely, which is V1's other
 * measured failure mode. Those shots are now routed to a photograph already taken from the
 * viewpoint they need, so the lock is working with the pipeline rather than against it —
 * but that is reasoning, not a measurement. The escape hatch exists for when it is worth
 * measuring:
 *
 *   OPENAI_INPUT_FIDELITY=low
 */
export function openaiInputFidelity(): 'high' | 'low' {
  return process.env.OPENAI_INPUT_FIDELITY?.trim() === 'low' ? 'low' : 'high'
}

/** USD. Claude is per-token; image models are per-image at the geometry we request. */
export const PRICING = {
  claude: { inputPerMTok: 5.0, outputPerMTok: 25.0 },
  images: {
    gemini: 0.134, // 1K/2K tier; 4K would be 0.24
    'openai-1-5': 0.133, // square, high quality
    'openai-2': 0.13, // estimate — recomputed from returned usage when available
  },
} as const

export type GeneratorId = 'gemini' | 'openai-1-5' | 'openai-2'

/**
 * Read once, explicitly, and fail loudly.
 *
 * The `.env` in this repo defines GEMINI_KEY, but Google's SDK convention is
 * GEMINI_API_KEY. Anything relying on SDK auto-pickup authenticates as nobody and fails
 * with a confusing 4xx at call time rather than at boot. Accept either name.
 */
function required(names: string[]): string {
  for (const name of names) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  throw new Error(
    `Missing required environment variable: ${names.join(' or ')}. ` +
      `Add it to .env in the project root.`,
  )
}

export function getKeys() {
  return {
    anthropic: required(['ANTHROPIC_API_KEY']),
    gemini: required(['GEMINI_KEY', 'GEMINI_API_KEY']),
    openai: required(['OPENAI_API_KEY']),
  }
}

/** Boot check — surfaces all missing keys at once instead of one per failed request. */
export function validateEnv(): { ok: true } | { ok: false; missing: string[] } {
  const missing: string[] = []
  if (!process.env.ANTHROPIC_API_KEY?.trim()) missing.push('ANTHROPIC_API_KEY')
  if (!process.env.GEMINI_KEY?.trim() && !process.env.GEMINI_API_KEY?.trim()) {
    missing.push('GEMINI_KEY')
  }
  if (!process.env.OPENAI_API_KEY?.trim()) missing.push('OPENAI_API_KEY')
  return missing.length ? { ok: false, missing } : { ok: true }
}

/**
 * Which generators are live.
 *
 * Stage 2 spec §9: image generation uses the OpenAI API exclusively, gpt-image-1.5. No other
 * vendor is used, tested, or compared against in this stage — so the side-by-side comparison
 * V1 ran is off, and the default is a single generator.
 *
 * The Gemini and gpt-image-2 implementations are left in place rather than deleted. They sit
 * behind the same `ImageGenerator` interface and cost nothing while switched off, and
 * deleting working, already-paid-for vendor integrations to enforce a stage-scoped decision
 * would have to be rewritten verbatim the moment the decision is revisited. Re-enabling is a
 * config change, not a code change:
 *
 *   ENABLED_GENERATORS=gemini,openai-1-5,openai-2
 *
 * Note that gemini has never been called successfully — the key available during development
 * was on the free tier, where gemini-3-pro-image has a request quota of 0.
 */
const DEFAULT_ENABLED: GeneratorId[] = ['openai-1-5']

export function enabledGenerators(): GeneratorId[] {
  const raw = process.env.ENABLED_GENERATORS?.trim()
  if (!raw) return DEFAULT_ENABLED
  const valid: GeneratorId[] = ['gemini', 'openai-1-5', 'openai-2']
  const picked = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is GeneratorId => valid.includes(s as GeneratorId))
  return picked.length ? picked : DEFAULT_ENABLED
}
