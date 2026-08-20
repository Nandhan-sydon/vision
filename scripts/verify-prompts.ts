/**
 * Build step 4 verification: write prompts for every slot, plus the adversarial hint
 * case that spec §10 turns on.
 *
 * Caches Visual DNA to runs/dna-cache/ and writes every prompt to runs/prompt-cache/,
 * so re-analysis costs nothing and a re-run only pays for the slots it re-writes.
 *
 *   npx tsx scripts/verify-prompts.ts [mug-ibm]
 */

import 'dotenv/config'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { extractImageDNA, type ImageDNA } from '../lib/claude/dna'
import { writePrompt } from '../lib/claude/prompt'
import { LISTING_SLOTS, getSlot } from '../lib/slots'
import { claudeCostUsd, usd } from '../lib/cost'
import { validateEnv } from '../lib/config'
import { checkHintLeak, leaked } from '../lib/hint-leak'

const HOSTILE =
  'put it on a red gradient background with a big SALE badge and some sparkles'
const HOSTILE_TERMS = ['red', 'gradient', 'sale', 'badge', 'sparkle']

async function getDna(slug: string): Promise<{ dna: ImageDNA; cost: number }> {
  const cacheFile = path.join('runs', 'dna-cache', `${slug}.json`)
  try {
    return { dna: JSON.parse(await readFile(cacheFile, 'utf8')), cost: 0 }
  } catch {
    const buf = await readFile(path.join('test-photos', `${slug}.jpg`))
    const { dna, usage } = await extractImageDNA({
      data: buf.toString('base64'),
      mediaType: 'image/jpeg',
    })
    await mkdir(path.dirname(cacheFile), { recursive: true })
    await writeFile(cacheFile, JSON.stringify(dna, null, 2))
    return { dna, cost: claudeCostUsd(usage) }
  }
}

async function main() {
  const env = validateEnv()
  if (!env.ok) {
    console.error(`Missing env: ${env.missing.join(', ')}`)
    process.exit(1)
  }

  const slug = process.argv[2] ?? 'mug-ibm'
  const outDir = path.join('runs', 'prompt-cache')
  await mkdir(outDir, { recursive: true })

  const { dna, cost: dnaCost } = await getDna(slug)
  console.log(`Product: ${dna.product}`)
  console.log(dnaCost ? `Visual DNA: ${usd(dnaCost)}\n` : 'Visual DNA: cached\n')

  let total = dnaCost

  for (const slot of LISTING_SLOTS) {
    const { result, usage, ms } = await writePrompt({ dna, slot })
    const cost = claudeCostUsd(usage)
    total += cost
    await writeFile(path.join(outDir, `${slug}-${slot.id}.txt`), result.prompt)
    console.log('='.repeat(78))
    console.log(
      `${slot.label.toUpperCase()}  [${slot.mode}]  hint=${result.hintHandling}  ` +
        `${(ms / 1000).toFixed(1)}s  ${usd(cost)}\n`,
    )
    console.log(result.prompt + '\n')
  }

  // The compliance test that matters most (spec §10).
  console.log('#'.repeat(78))
  console.log(`ADVERSARIAL HINT ON MAIN\n  user typed: "${HOSTILE}"\n`)
  const { result, usage } = await writePrompt({
    dna,
    slot: getSlot('main'),
    hint: HOSTILE,
  })
  total += claudeCostUsd(usage)
  await writeFile(path.join(outDir, `${slug}-main-adversarial.txt`), result.prompt)

  const checks = checkHintLeak(result.prompt, HOSTILE_TERMS)
  const leaks = leaked(checks)

  console.log(result.prompt + '\n')
  console.log(`hintHandling : ${result.hintHandling}`)
  for (const c of checks) {
    if (!c.occurrences) continue
    console.log(
      `  "${c.term}" x${c.occurrences} — ${c.negated} negated, ${c.positive} positive`,
    )
  }
  console.log(`leaked       : ${leaks.length ? leaks.map((l) => l.term).join(', ') : 'none'}`)
  const pass = result.hintHandling === 'rejected' && leaks.length === 0
  console.log(`VERDICT      : ${pass ? 'PASS' : 'REVIEW'}`)
  console.log(`\ntotal ${usd(total)}`)
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
