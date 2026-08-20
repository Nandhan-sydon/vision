/**
 * Full TEXT pipeline, no image generation.
 *
 *   photo -> Visual DNA -> shot plan -> a written prompt for every planned shot
 *
 * Proves the dynamic-slot wiring end to end and shows what would be sent to the image
 * models, without spending anything on generation.
 *
 *   npx tsx scripts/verify-text-pipeline.ts                 # all test photos
 *   npx tsx scripts/verify-text-pipeline.ts mug-ibm watch-fossil
 *   npx tsx scripts/verify-text-pipeline.ts --no-prompts    # plans only (cheaper)
 */

import 'dotenv/config'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import { extractImageDNA, type ImageDNA } from '../lib/claude/dna'
import { planShots, buildSlotSet, type ShotPlan } from '../lib/claude/shot-plan'
import { writePrompt } from '../lib/claude/prompt'
import { claudeCostUsd, usd } from '../lib/cost'
import { validateEnv } from '../lib/config'

const OUT = path.join('runs', 'text-pipeline')

async function cached<T>(file: string, make: () => Promise<{ value: T; cost: number }>) {
  try {
    return { value: JSON.parse(await readFile(file, 'utf8')) as T, cost: 0 }
  } catch {
    const { value, cost } = await make()
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify(value, null, 2))
    return { value, cost }
  }
}

const MARK: Record<string, string> = {
  derivable: 'GEN  ',
  partial: 'GEN? ',
  'needs-new-photo': 'PHOTO',
}

async function main() {
  const env = validateEnv()
  if (!env.ok) { console.error(`Missing env: ${env.missing.join(', ')}`); process.exit(1) }

  const noPrompts = process.argv.includes('--no-prompts')
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const slugs = args.length
    ? args
    : (await readdir('test-photos'))
        .filter((f) => /\.jpe?g$/i.test(f))
        .map((f) => path.parse(f).name)

  await mkdir(OUT, { recursive: true })
  let total = 0
  const report: Record<string, unknown>[] = []

  for (const slug of slugs) {
    const dnaRes = await cached<ImageDNA>(
      path.join('runs', 'dna-cache', `${slug}.json`),
      async () => {
        const buf = await readFile(path.join('test-photos', `${slug}.jpg`))
        const { dna, usage } = await extractImageDNA({
          data: buf.toString('base64'), mediaType: 'image/jpeg',
        })
        return { value: dna, cost: claudeCostUsd(usage) }
      },
    )
    total += dnaRes.cost

    const planRes = await cached<ShotPlan>(
      path.join(OUT, `${slug}.plan.json`),
      async () => {
        const { plan, usage } = await planShots(dnaRes.value)
        return { value: plan, cost: claudeCostUsd(usage) }
      },
    )
    total += planRes.cost

    const { slots, deferred } = buildSlotSet(planRes.value, dnaRes.value)

    console.log('='.repeat(88))
    console.log(`${slug}  —  ${dnaRes.value.product.slice(0, 64)}`)
    console.log(`${planRes.value.productSummary}\n`)
    for (const s of planRes.value.shots) {
      console.log(`  [${MARK[s.feasibility]}] ${s.label.padEnd(22)} ${s.rationale.slice(0, 76)}`)
    }
    console.log(`\n  generate: ${slots.map((s) => s.id).join(', ')}`)
    if (deferred.length) console.log(`  request : ${deferred.map((s) => s.id).join(', ')}`)

    const prompts: Record<string, string> = {}
    if (!noPrompts) {
      console.log()
      for (const slot of slots) {
        const { result, usage, ms } = await writePrompt({ dna: dnaRes.value, slot })
        const c = claudeCostUsd(usage)
        total += c
        prompts[slot.id] = result.prompt
        const words = result.prompt.split(/\s+/).length
        console.log(
          `  prompt ${slot.id.padEnd(24)} ${String(words).padStart(4)}w  ` +
            `${(ms / 1000).toFixed(0)}s  ${usd(c)}  hint=${result.hintHandling}`,
        )
      }
      await writeFile(path.join(OUT, `${slug}.prompts.json`), JSON.stringify(prompts, null, 2))
    }

    report.push({
      slug,
      product: dnaRes.value.product,
      summary: planRes.value.productSummary,
      generate: slots.map((s) => s.id),
      request: deferred.map((s) => ({ id: s.id, label: s.label, rationale: s.rationale })),
      shots: planRes.value.shots,
      prompts,
    })
    console.log()
  }

  await writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  console.log('='.repeat(88))
  console.log(`total ${usd(total)}   →  ${OUT}/report.json`)
}

main().catch((e) => { console.error('FAILED:', e instanceof Error ? e.message : e); process.exit(1) })
