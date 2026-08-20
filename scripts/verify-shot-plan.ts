/**
 * Does the shot plan actually adapt to the product, or does it produce the same
 * generic rotation series regardless? Run across products to find out.
 *
 *   npx tsx scripts/verify-shot-plan.ts mug-ibm backpack
 */
import 'dotenv/config'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { extractImageDNA, type ImageDNA } from '../lib/claude/dna'
import { planShots, buildSlotSet } from '../lib/claude/shot-plan'
import { claudeCostUsd, usd } from '../lib/cost'
import { validateEnv } from '../lib/config'

async function getDna(slug: string): Promise<{ dna: ImageDNA; cost: number }> {
  const cache = path.join('runs', 'dna-cache', `${slug}.json`)
  try {
    return { dna: JSON.parse(await readFile(cache, 'utf8')), cost: 0 }
  } catch {
    const buf = await readFile(path.join('test-photos', `${slug}.jpg`))
    const { dna, usage } = await extractImageDNA({
      data: buf.toString('base64'),
      mediaType: 'image/jpeg',
    })
    await mkdir(path.dirname(cache), { recursive: true })
    await writeFile(cache, JSON.stringify(dna, null, 2))
    return { dna, cost: claudeCostUsd(usage) }
  }
}

const MARK: Record<string, string> = {
  derivable: 'OK  ',
  partial: 'PART',
  'needs-new-photo': 'PHOTO',
}

async function main() {
  const env = validateEnv()
  if (!env.ok) { console.error(`Missing env: ${env.missing.join(', ')}`); process.exit(1) }

  const slugs = process.argv.slice(2)
  if (!slugs.length) { console.error('usage: ... <slug> [slug...]'); process.exit(1) }

  let total = 0
  for (const slug of slugs) {
    const { dna, cost: dnaCost } = await getDna(slug)
    total += dnaCost
    const { plan, usage, ms } = await planShots(dna)
    const cost = claudeCostUsd(usage)
    total += cost

    console.log('='.repeat(84))
    console.log(`${slug}  —  ${dna.product.slice(0, 60)}`)
    console.log(`${plan.productSummary}`)
    console.log(`(${(ms / 1000).toFixed(1)}s, ${usd(cost)}${dnaCost ? ` + ${usd(dnaCost)} dna` : ' , dna cached'})\n`)

    for (const s of plan.shots) {
      console.log(`  [${MARK[s.feasibility]}] ${s.label.padEnd(22)} ${s.rationale.slice(0, 84)}`)
    }

    const { slots, deferred } = buildSlotSet(plan, dna)
    console.log(`\n  → generate ${slots.length} slot(s): ${slots.map((s) => s.id).join(', ')}`)
    if (deferred.length) {
      console.log(`  → ask seller to photograph: ${deferred.map((s) => s.id).join(', ')}`)
    }
    console.log()
  }
  console.log(`total ${usd(total)}`)
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1) })
