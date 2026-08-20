/**
 * Claim-language safety check — Stage 2 spec §13.
 *
 * Runs on every piece of text before it is rendered into an infographic:
 *
 *   shot plan ─▶ prompt ─▶ render ─▶ CLAIM CHECK ─▶ compliance pass ─▶ output
 *
 * A rejected claim is REWRITTEN. It is never force-published, and the seller is never given
 * an override path (§13, §18). That is why this returns replacement text rather than a
 * boolean: a checker that only says "no" invites a caller to ship the original anyway, and a
 * caller that has to invent the replacement will invent one that fails the same way.
 *
 * ## Why the judgement is a model and not a word list
 *
 * §13 is explicit that this is a pattern and intent judgement. "Kills 99.9% of bacteria" and
 * "eliminates 99.9% of germs" are the same unregistered pesticide-class claim; a word list
 * catches the first and ships the second. The same holds for every category here — a claim
 * reworded to dodge a banned word is still the same claim, and the rewrite is the attack.
 *
 * The deterministic pre-filter below is not the check. It is a cheap first pass over the
 * phrases that are *never* acceptable in any context, so an obviously bad string does not
 * cost an API call. Anything it does not catch still goes to the model — passing the
 * pre-filter is not passing the check.
 */

import { CLAUDE_MAX_TOKENS, MODELS } from './config'
import { claude, firstText, parseJson } from './claude/client'
import type { ClaudeUsage } from './cost'

export type ClaimFindingKind =
  /** "treats", "cures", "prevents", a named disease or condition. */
  | 'medical'
  /** "clinically proven", "FDA approved", "dermatologist tested" without substantiation. */
  | 'unsubstantiated-proof'
  /** "kills 99.9%", "eliminates germs" — unregistered pesticide-class claims. */
  | 'pesticidal'
  /** "Amazon's Choice", "Prime eligible", "Best Seller", star ratings. */
  | 'platform-badge'
  /** "free shipping", warranty and guarantee promises. */
  | 'third-party-guarantee'
  /** A superlative or outcome promise nothing supports: "the best", "guaranteed results". */
  | 'unsupported-superlative'
  /** An award, certification, or seal that does not exist. */
  | 'fabricated-credential'

export type ClaimFinding = {
  kind: ClaimFindingKind
  /** The offending fragment, quoted from the input. */
  fragment: string
  /** Why it fails, in one sentence. */
  reason: string
}

export type ClaimCheckResult = {
  /** True when the text was already safe and is unchanged. */
  clean: boolean
  original: string
  /**
   * The text to render. Equal to `original` when clean; a compliant rewrite otherwise.
   *
   * Empty only when the claim cannot be salvaged into any lawful statement — a headline whose
   * entire content is a medical claim has nothing left once the claim is removed. The caller
   * must drop the callout rather than render an empty one.
   */
  safe: string
  findings: ClaimFinding[]
  /** True when the fragment was removed entirely rather than reworded. */
  dropped: boolean
}

/**
 * Phrases with no lawful use on a marketplace listing image, in any product category or
 * phrasing. Matched case-insensitively as whole phrases.
 *
 * Kept short on purpose. This is not the rule set — it is the set of strings for which an
 * API call would be a waste, and every entry is one §13 or §17 names explicitly.
 */
const NEVER_ACCEPTABLE = [
  "amazon's choice",
  'amazons choice',
  'prime eligible',
  'best seller',
  'bestseller',
  'fda approved',
  'fda-approved',
  'clinically proven',
  'doctor recommended',
  'free shipping',
  'money back guarantee',
  'money-back guarantee',
]

/** Structure/function language §13 explicitly permits. Never rewritten on its own. */
const PERMITTED_VERBS = ['supports', 'maintains', 'promotes', 'helps maintain']

export function prefilter(text: string): string[] {
  const lower = text.toLowerCase()
  return NEVER_ACCEPTABLE.filter((phrase) => lower.includes(phrase))
}

const SCHEMA = {
  type: 'object',
  properties: {
    clean: {
      type: 'boolean',
      description: 'True only if the text is already compliant and needs no change at all.',
    },
    safe: {
      type: 'string',
      description:
        'The text to render. Identical to the input when clean. Otherwise a rewrite that keeps as much of the seller\'s meaning as is lawful. Empty string ONLY if nothing lawful remains once the claim is removed.',
    },
    dropped: {
      type: 'boolean',
      description: 'True if the claim could not be salvaged and the text must not be rendered.',
    },
    findings: {
      type: 'array',
      description: 'One entry per distinct problem. Empty when clean.',
      items: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: [
              'medical',
              'unsubstantiated-proof',
              'pesticidal',
              'platform-badge',
              'third-party-guarantee',
              'unsupported-superlative',
              'fabricated-credential',
            ],
          },
          fragment: { type: 'string', description: 'The offending fragment, quoted exactly.' },
          reason: { type: 'string', description: 'Why it fails, in one sentence.' },
        },
        required: ['kind', 'fragment', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['clean', 'safe', 'dropped', 'findings'],
  additionalProperties: false,
} as const

const SYSTEM = `You check short pieces of marketing copy destined for a product listing image, and rewrite anything that cannot lawfully be published.

Judge the CLAIM, not the wording. A claim reworded to avoid a banned word is still the same claim and still fails. "Kills 99.9% of bacteria" and "eliminates 99.9% of household germs" are one claim in two costumes; so are "cures acne" and "clears breakouts caused by acne". Ask what a buyer would understand the text to promise, and rule on that.

## Permitted

Structure and function language: supports, maintains, promotes, helps maintain. Plain factual description of what the product is, what it is made of, what it fits, how large it is, how it is used. Accurate, verifiable specifics.

## Rejected, and rewritten

- **Medical**: treats, cures, prevents, heals, relieves, remedies; any named disease or medical condition; any implication that the product addresses one.
- **Unsubstantiated proof**: "clinically proven", "scientifically proven", "dermatologist tested", "FDA approved" — unless it is literally true and verified, which you cannot assume from the text alone, so treat it as unverified.
- **Pesticidal**: "kills 99.9%", "eliminates bacteria/germs/viruses", antimicrobial or disinfectant claims. These are a registered-pesticide class and require registration this product does not have.
- **Platform badges**: any reference to a marketplace programme — "Amazon's Choice", "Prime", "Prime eligible", "Best Seller", "#1 in category" — and any star rating or review-score graphic.
- **Third-party guarantees**: "free shipping", warranty promises, money-back guarantees, unless the text itself states them as an accurate and verified fact, which you should not assume.
- **Fabricated credentials**: awards, certifications, seals, or endorsements not established as real.
- **Unsupported superlatives and outcome promises**: "the best", "#1", "guaranteed results", "instantly transforms".

## How to rewrite

Keep as much of the seller's actual meaning as is lawful, and keep it short — this is a callout on an image, not a paragraph. Prefer converting an outcome promise into a description of the product:

  "Kills 99.9% of bacteria"        -> "Wipeable, non-porous surface"
  "Clinically proven to reduce pain" -> "Contoured support at the lower back"
  "Amazon's Choice for yoga mats"    -> "6mm cushioned yoga mat"
  "Best sleep guaranteed"            -> "Memory foam with a breathable cover"

Set dropped true and safe to an empty string ONLY when nothing lawful survives — the whole text is the claim and there is no product fact underneath it to keep. Do not invent a product fact you were not given in order to fill the space.

Never explain the rejection in the rewritten text. The rewrite is the deliverable.`

export async function checkClaim(
  text: string,
): Promise<{ result: ClaimCheckResult; usage?: ClaudeUsage; ms: number }> {
  const started = Date.now()
  const trimmed = text.trim()

  if (!trimmed) {
    return {
      result: { clean: true, original: text, safe: '', findings: [], dropped: false },
      ms: 0,
    }
  }

  const response = await claude().messages.create({
    model: MODELS.claude,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content:
          `Check this listing-image text:\n\n"${trimmed}"` +
          (prefilter(trimmed).length
            ? `\n\nA deterministic pre-filter already flagged: ${prefilter(trimmed).join(', ')}. ` +
              'These are never acceptable in any phrasing, so the text is not clean whatever ' +
              'else you find.'
            : ''),
      },
    ],
  })

  const raw = parseJson<Omit<ClaimCheckResult, 'original'>>(
    firstText(response),
    'Claim check',
  )

  // The pre-filter overrides an approving verdict. Its phrases have no lawful use in any
  // context, so a "clean" answer about one is wrong by construction rather than debatable.
  const forced = prefilter(trimmed)
  const clean = raw.clean && forced.length === 0

  return {
    result: {
      clean,
      original: text,
      // Never fall back to the original on a non-clean verdict: §13 forbids force-publishing
      // a rejected claim, and defaulting to the input on a malformed response would do
      // exactly that, silently.
      safe: clean ? trimmed : raw.dropped ? '' : raw.safe.trim(),
      findings: raw.findings ?? [],
      dropped: !clean && (raw.dropped || !raw.safe.trim()),
    },
    usage: response.usage as ClaudeUsage,
    ms: Date.now() - started,
  }
}

/** Check several callouts, dropping any that cannot be salvaged. */
export async function checkClaims(
  texts: string[],
): Promise<{ results: ClaimCheckResult[]; safeTexts: string[]; usdTokens: ClaudeUsage[] }> {
  const results: ClaimCheckResult[] = []
  const usdTokens: ClaudeUsage[] = []

  for (const text of texts) {
    const { result, usage } = await checkClaim(text)
    results.push(result)
    if (usage) usdTokens.push(usage)
  }

  return {
    results,
    safeTexts: results.filter((r) => !r.dropped && r.safe).map((r) => r.safe),
    usdTokens,
  }
}

/** True when every piece of text is safe to render as-is or after rewriting. */
export function allRenderable(results: ClaimCheckResult[]): boolean {
  return results.every((r) => !r.dropped)
}

export { PERMITTED_VERBS }
