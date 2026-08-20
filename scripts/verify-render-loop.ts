/**
 * The full loop for one shot, end to end: write → generate → correct → review → retry.
 *
 *   npx tsx scripts/verify-render-loop.ts --dir test-photos/sets/cricket-bat --slot main
 *   npx tsx scripts/verify-render-loop.ts --dir <dir> --shot 1 --attempts 3
 *   npx tsx scripts/verify-render-loop.ts --dir <dir> --shot 1 --no-review   # V1 baseline
 *
 * THIS ONE SPENDS MONEY. Each attempt is a real image generation (~$0.13 and 40-140s) plus
 * a review, so three attempts is roughly $0.45 and several minutes. Everything else in the
 * pipeline can be verified for cents; this is the only script that cannot.
 *
 * Every attempt is written to runs/render-loop/ alongside its review as JSON. That is the
 * point of the script: the loop's claim is "attempt 1 was rejected for a specific fault and
 * attempt 2 fixed it", and that claim is only worth anything if the two images can be put
 * side by side and the fault looked for by eye. A review trail nobody checks is a review
 * trail that can be quietly wrong for months.
 *
 * `--no-review` renders the same shot with the loop switched off, which is the honest
 * comparison: it shows what V1 would have shipped for the same prompt and the same photos,
 * at one third the cost.
 */

import 'dotenv/config'
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { extractImageDNA } from '../lib/claude/dna'
import { planShots, buildSlotSet } from '../lib/claude/shot-plan'
import { renderShot, renderOutcomeLines } from '../lib/render-shot'
import { loadBuildMemory, saveBuildMemory } from '../lib/build-memory'
import { productKey } from '../lib/product-key'
import { geminiGenerator } from '../lib/generators/gemini'
import { openai15Generator, openai2Generator } from '../lib/generators/openai'
import type { ImageGenerator } from '../lib/generators/types'
import { usd } from '../lib/cost'
import { validateEnv, enabledGenerators, type GeneratorId } from '../lib/config'
import { MAX_PHOTOS, photoLabel, type Base64Image } from '../lib/photos'
import type { Slot } from '../lib/slots'

const REGISTRY: Record<GeneratorId, ImageGenerator> = {
  gemini: geminiGenerator,
  'openai-1-5': openai15Generator,
  'openai-2': openai2Generator,
}

const MEDIA: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

const flag = (name: string) => process.argv.includes(`--${name}`)
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

async function loadDir(dir: string): Promise<{ photos: Base64Image[]; names: string[] }> {
  const entries = (await readdir(dir))
    .filter((f) => MEDIA[path.extname(f).toLowerCase()])
    .sort()
    .slice(0, MAX_PHOTOS)
  if (!entries.length) throw new Error(`No images found in ${dir}`)
  const photos = await Promise.all(
    entries.map(async (f) => ({
      data: (await readFile(path.join(dir, f))).toString('base64'),
      mediaType: MEDIA[path.extname(f).toLowerCase()],
    })),
  )
  return { photos, names: entries }
}

async function main() {
  const env = validateEnv()
  if (!env.ok) {
    console.error(`Missing env: ${env.missing.join(', ')}`)
    process.exit(1)
  }

  const dir = arg('dir')
  if (!dir) {
    console.error('Usage: verify-render-loop.ts --dir <dir-of-photos> [--slot main | --shot N]')
    process.exit(1)
  }

  const generatorId = (arg('generator') ?? enabledGenerators()[0]) as GeneratorId
  const generator = REGISTRY[generatorId]
  if (!generator) {
    console.error(`Unknown generator "${generatorId}".`)
    process.exit(1)
  }

  const attempts = Number(arg('attempts') ?? 3)
  const review = !flag('no-review')

  const { photos, names } = await loadDir(dir)
  console.log(`${photos.length} photo(s) from ${dir}`)
  names.forEach((n, i) => console.log(`  ${photoLabel(i)} = ${n}`))
  console.log()

  process.stdout.write('Fingerprint … ')
  const { dna } = await extractImageDNA(photos)
  console.log(dna.product)

  process.stdout.write('Shot plan … ')
  const { plan } = await planShots(dna)
  const set = buildSlotSet(plan, dna)
  console.log(`${set.slots.length} generable, ${set.deferrals.length} deferred`)

  let slot: Slot | undefined
  const slotId = arg('slot')
  const shotIndex = arg('shot')
  if (slotId) slot = set.slots.find((s) => s.id === slotId)
  else if (shotIndex) slot = set.slots[Number(shotIndex)]
  else slot = set.slots[0]

  if (!slot) {
    console.error(
      `No such shot. Available: ${set.slots.map((s, i) => `${i}=${s.id}`).join(', ')}`,
    )
    process.exit(1)
  }

  console.log(
    `\nShot: ${slot.label} [${slot.kind ?? 'angle'}] · ${slot.renderMode ?? 'edit'} · ` +
      `from ${(slot.sourcePhotos ?? []).map((i) => photoLabel(i)).join(', ') || 'no photo'}`,
  )
  console.log(`Generator: ${generator.label} · up to ${attempts} attempt(s) · review ${review ? 'ON' : 'OFF'}\n`)

  // Loaded and saved so consecutive runs of this script behave like consecutive shots of one
  // listing — which is the only way the style-matching in build memory can be observed.
  const key = productKey(dna)
  const buildMemory = await loadBuildMemory(key)
  if (buildMemory.entries.length) {
    console.log(
      `Build memory: ${buildMemory.entries.length} earlier shot(s) — ` +
        `${buildMemory.entries.map((e) => e.shotId).join(', ')}`,
    )
  }

  const outcome = await renderShot({
    generator,
    dna,
    slot,
    photos,
    buildMemory,
    maxAttempts: attempts,
    review,
    onProgress: ({ stage, attempt, detail }) =>
      console.log(`  [attempt ${attempt}] ${stage}${detail ? ` (${detail})` : ''} …`),
  })

  await saveBuildMemory(outcome.buildMemory)

  console.log()
  for (const line of renderOutcomeLines(outcome)) console.log(line)

  const outDir = path.resolve('runs/render-loop', `${slot.id}-${generatorId}`)
  await mkdir(outDir, { recursive: true })
  for (const a of outcome.attempts) {
    const ext = a.mimeType.includes('jpeg') ? 'jpg' : 'png'
    await writeFile(path.join(outDir, `attempt-${a.n}.${ext}`), Buffer.from(a.imageBase64, 'base64'))
    await writeFile(
      path.join(outDir, `attempt-${a.n}.json`),
      JSON.stringify(
        {
          n: a.n,
          prompt: a.prompt,
          referenceIndexes: a.referenceIndexes,
          style: { lighting: a.style.lighting.id, scene: a.style.scene?.id ?? null, shadow: a.style.shadow },
          review: a.review,
          compliance: a.compliance,
          costUsd: a.costUsd,
          ms: a.ms,
        },
        null,
        2,
      ),
    )
  }

  console.log(`\nAttempts written to ${outDir}`)
  console.log(
    `passed=${outcome.passed} stopped=${outcome.stoppedBecause} ` +
      `shipped=attempt ${outcome.best.n} total=${usd(outcome.costUsd)} ` +
      `${(outcome.ms / 1000).toFixed(0)}s`,
  )
  if (outcome.attempts.length > 1) {
    console.log(
      '\nOpen the attempts side by side and check the reviewer was right about the fault ' +
        'it named. That check is the only thing that makes the trail worth keeping.',
    )
  }
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
