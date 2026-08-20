/**
 * Did a rejected user hint leak into the prompt Claude wrote?
 *
 * Two traps make naive matching useless here:
 *
 *  1. Substring matching false-positives badly — "red" appears inside "centered" and
 *     "decal-fired", both of which are perfectly innocent.
 *  2. A COMPLIANT Main prompt legitimately contains "no gradient" and "no badges",
 *     precisely because it is spelling out the hard rules. Counting those as leaks
 *     inverts the test.
 *
 * So: tokenise into words, match whole words (allowing plurals), and treat a mention
 * governed by a nearby negation as compliance rather than leakage.
 *
 * Deliberately tokenises rather than using RegExp word boundaries — building `\b` into
 * a RegExp string is fragile across tooling, and words are what we actually mean.
 */

const NEGATORS = new Set([
  'no',
  'not',
  'never',
  'without',
  'avoid',
  'excluding',
  'nor',
  'free',
  'zero',
])

/** How many preceding words a negation can reach forward to govern. */
const NEGATION_WINDOW = 12

export type LeakCheck = {
  term: string
  occurrences: number
  negated: number
  positive: number
  /** Short quotes around each positive (i.e. genuinely leaked) mention. */
  contexts: string[]
}

function tokenise(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9#]+/).filter(Boolean)
}

export function checkHintLeak(prompt: string, terms: string[]): LeakCheck[] {
  const words = tokenise(prompt)

  return terms.map((rawTerm) => {
    const term = rawTerm.toLowerCase()
    let occurrences = 0
    let negated = 0
    let positive = 0
    const contexts: string[] = []

    words.forEach((word, i) => {
      // Whole word, tolerating simple inflections: badge/badges, sparkle/sparkles.
      if (word !== term && word !== `${term}s` && word !== `${term}es`) return
      occurrences++

      const from = Math.max(0, i - NEGATION_WINDOW)
      const isNegated = words.slice(from, i).some((w) => NEGATORS.has(w))
      if (isNegated) {
        negated++
      } else {
        positive++
        contexts.push(words.slice(Math.max(0, i - 6), i + 4).join(' '))
      }
    })

    return { term, occurrences, negated, positive, contexts }
  })
}

/** A hint is cleanly rejected when nothing from it survives as a positive instruction. */
export function leaked(checks: LeakCheck[]): LeakCheck[] {
  return checks.filter((c) => c.positive > 0)
}
