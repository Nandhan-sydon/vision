/**
 * Does the claim-language check catch the claim rather than the wording?
 *
 *   npx tsx scripts/verify-claim-check.ts
 *
 * ~$0.10, no image generation. §13 is explicit that this is a pattern and intent judgement,
 * so the cases that matter are the ones where a word list gets the wrong answer in both
 * directions:
 *
 *   - a banned claim reworded to dodge every banned word must still be caught
 *   - permitted structure/function language must NOT be rewritten, or the checker quietly
 *     strips the seller's legitimate copy on every listing
 *
 * A rejected claim must come back rewritten and publishable, never merely refused: §13 gives
 * the seller no override path, so the rewrite is the only route to a rendered callout.
 */

import 'dotenv/config'
import { checkClaim } from '../lib/claim-check'
import { claudeCostUsd, usd } from '../lib/cost'
import { validateEnv } from '../lib/config'

type Case = {
  text: string
  /** 'clean' = publish unchanged. 'rewrite' = must be changed before rendering. */
  expect: 'clean' | 'rewrite'
  why: string
}

const CASES: Case[] = [
  {
    text: 'Supports healthy posture during long working days',
    expect: 'clean',
    why: '§13 permits structure/function language explicitly. Rewriting this is a false positive on every listing.',
  },
  {
    text: '6mm cushioned yoga mat with a non-slip base',
    expect: 'clean',
    why: 'Plain factual description. Nothing to judge.',
  },
  {
    text: 'Clinically proven to relieve back pain',
    expect: 'rewrite',
    why: 'Unsubstantiated proof plus a medical claim. The obvious case.',
  },
  {
    text: 'Kills 99.9% of bacteria on contact',
    expect: 'rewrite',
    why: 'Unregistered pesticide-class claim.',
  },
  {
    text: 'Eliminates 99.9% of household germs — no harsh chemicals',
    expect: 'rewrite',
    why: 'THE case that matters. Same pesticidal claim as above with every banned word swapped out. A word list ships this.',
  },
  {
    text: 'Helps clear the breakouts that acne causes',
    expect: 'rewrite',
    why: 'A medical claim rephrased around "treats" and "cures". Names a condition and promises an outcome.',
  },
  {
    text: "Amazon's Choice for kitchen storage",
    expect: 'rewrite',
    why: 'Platform badge. Caught by the deterministic prefilter, which must override any approving verdict.',
  },
  {
    text: 'Rated #1 by customers — 5 stars',
    expect: 'rewrite',
    why: 'Star rating and an unsupported superlative, with no banned phrase present.',
  },
]

async function main() {
  const env = validateEnv()
  if (!env.ok) {
    console.error(`Missing env: ${env.missing.join(', ')}`)
    process.exit(1)
  }

  let total = 0
  let ok = 0

  for (const c of CASES) {
    const { result, usage, ms } = await checkClaim(c.text)
    if (usage) total += claudeCostUsd(usage)

    const behaved = c.expect === 'clean' ? result.clean : !result.clean
    if (behaved) ok++

    console.log(`${behaved ? 'OK  ' : 'FAIL'}  "${c.text}"`)
    console.log(`      expected ${c.expect}, got ${result.clean ? 'clean' : 'rewrite'} (${(ms / 1000).toFixed(1)}s)`)
    if (!result.clean) {
      for (const f of result.findings) console.log(`      [${f.kind}] ${f.reason}`)
      console.log(
        result.dropped
          ? '      -> DROPPED: nothing lawful remained, the callout must not be rendered'
          : `      -> "${result.safe}"`,
      )
      // A rewrite that is itself non-compliant would be shipped, so the output is the part
      // worth reading rather than the verdict.
      if (!result.dropped && !result.safe) {
        console.log('      !! non-clean with empty safe text and dropped=false — unshippable')
      }
    }
    console.log(`      ${c.why}`)
    console.log()
  }

  console.log(`${ok}/${CASES.length} behaved as expected · ${usd(total)}`)
  process.exit(ok === CASES.length ? 0 : 1)
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
