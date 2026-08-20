/**
 * Does the pose fix actually work?
 *
 * Picks a shot the planner flagged as needing a new camera viewpoint, then renders that
 * SAME shot both ways on the same model:
 *
 *   edit     images.edit, photo anchors the composition   → expected: no pose change
 *   compose  images.generate, prompt carries the likeness → expected: pose changes
 *
 * Each route gets its own prompt, because the prompt writer is mode-aware: in compose it
 * knows the generator never sees the photo and must be told every identity detail.
 *
 * Writes both images plus a side-by-side strip with the source, and runs the deterministic
 * checks. One model only (GPT Image 1.5 — 39s, $0.13) to keep this cheap.
 *
 *   npx tsx scripts/verify-pose-fix.ts [mug-ibm]
 */

import 'dotenv/config'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'
import { extractImageDNA, type ImageDNA } from '../lib/claude/dna'
import { planShots, type ShotPlan } from '../lib/claude/shot-plan'
import { writePrompt } from '../lib/claude/prompt'
import { openai15Generator } from '../lib/generators/openai'
import type { Slot } from '../lib/slots'
import { claudeCostUsd, usd } from '../lib/cost'
import { validateEnv } from '../lib/config'

const OUT = path.join('runs', 'pose-fix')

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

async function main() {
  const env = validateEnv()
  if (!env.ok) {
    console.error(`Missing env: ${env.missing.join(', ')}`)
    process.exit(1)
  }

  const slug = process.argv[2] ?? 'mug-ibm'
  await mkdir(OUT, { recursive: true })
  let total = 0

  const photoPath = path.join('test-photos', `${slug}.jpg`)
  const raw = await readFile(photoPath)
  const refImage = { data: raw.toString('base64'), mediaType: 'image/jpeg' }

  const dnaRes = await cached<ImageDNA>(
    path.join('runs', 'dna-cache', `${slug}.json`),
    async () => {
      const { dna, usage } = await extractImageDNA(refImage)
      return { value: dna, cost: claudeCostUsd(usage) }
    },
  )
  total += dnaRes.cost

  // Re-planned under the new schema so shots carry renderMode.
  const planRes = await cached<ShotPlan>(
    path.join(OUT, `${slug}.plan.json`),
    async () => {
      const { plan, usage } = await planShots(dnaRes.value)
      return { value: plan, cost: claudeCostUsd(usage) }
    },
  )
  total += planRes.cost

  const target = planRes.value.shots.find((s) => s.renderMode === 'compose')
  if (!target) {
    console.log('Planner flagged no shot as needing a viewpoint change. Shots were:')
    for (const s of planRes.value.shots) {
      console.log(`  ${s.label.padEnd(24)} renderMode=${s.renderMode}`)
    }
    process.exit(1)
  }

  console.log(`product : ${dnaRes.value.product.slice(0, 62)}`)
  console.log(`shot    : ${target.label}  (${target.id})`)
  console.log(`why     : ${target.rationale}`)
  console.log(`directive: ${target.directive.slice(0, 150)}…\n`)

  const results: { mode: 'edit' | 'compose'; file: string }[] = []

  for (const mode of ['edit', 'compose'] as const) {
    const slot: Slot = { ...target, renderMode: mode }
    const { result, usage } = await writePrompt({ dna: dnaRes.value, slot })
    total += claudeCostUsd(usage)
    await writeFile(path.join(OUT, `${slug}-${target.id}-${mode}.prompt.txt`), result.prompt)

    process.stdout.write(
      `${mode.padEnd(8)} prompt ${String(result.prompt.split(/\s+/).length).padStart(4)}w … `,
    )

    try {
      const r = await openai15Generator.generate(result.prompt, refImage, mode)
      total += r.costUsd
      const file = path.join(OUT, `${slug}-${target.id}-${mode}.png`)
      await writeFile(file, Buffer.from(r.imageBase64, 'base64'))
      results.push({ mode, file })
      console.log(`${(r.ms / 1000).toFixed(0)}s ${usd(r.costUsd)} → ${path.basename(file)}`)
    } catch (err) {
      console.log(`FAIL ${err instanceof Error ? err.message : err}`)
    }
  }

  if (results.length === 2) {
    const CELL = 360
    const PAD = 6
    const files = [photoPath, ...results.map((r) => r.file)]
    const comps: OverlayOptions[] = []
    for (let i = 0; i < files.length; i++) {
      comps.push({
        input: await sharp(files[i])
          .resize(CELL, CELL, { fit: 'contain', background: '#ffffff' })
          .png()
          .toBuffer(),
        left: i * (CELL + PAD) + PAD,
        top: PAD,
      })
    }
    const strip = path.join(OUT, `${slug}-${target.id}-comparison.png`)
    await sharp({
      create: {
        width: files.length * (CELL + PAD) + PAD,
        height: CELL + PAD * 2,
        channels: 3,
        background: '#d0d0d0',
      },
    })
      .composite(comps)
      .png()
      .toFile(strip)
    console.log(`\ncomparison → ${strip}   (source | edit | compose)`)
  }

  console.log(`\ntotal ${usd(total)}`)
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
