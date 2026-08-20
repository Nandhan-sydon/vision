/**
 * Re-analyse a saved prompt for leaked hint terms, without paying for a new Claude call.
 *
 *   npx tsx scripts/check-leak.ts runs/prompt-cache/mug-ibm-main-adversarial.txt
 */
import { readFile } from 'node:fs/promises'
import { checkHintLeak, leaked } from '../lib/hint-leak'

const TERMS = ['red', 'gradient', 'sale', 'badge', 'sparkle']

async function main() {
  const file = process.argv[2]
  if (!file) {
    console.error('usage: npx tsx scripts/check-leak.ts <prompt.txt>')
    process.exit(1)
  }
  const prompt = await readFile(file, 'utf8')
  const checks = checkHintLeak(prompt, TERMS)

  for (const c of checks) {
    console.log(
      `${c.term.padEnd(10)} occurrences ${c.occurrences}  negated ${c.negated}  positive ${c.positive}`,
    )
  }
  const l = leaked(checks)
  console.log(`\nleaked: ${l.length ? l.map((x) => x.term).join(', ') : 'none'}`)
}

main()
