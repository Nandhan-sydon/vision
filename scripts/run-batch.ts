/**
 * Full test matrix (spec §8): every test photo × its planned shots × every enabled
 * generator.
 *
 * Resumable — re-running skips cells already present in the run's manifest, so a rate
 * limit or a crash three products in does not cost a full re-run. Concurrency is capped
 * because the whole point of a spec §8 report is to note rate limits, not to trigger
 * them.
 *
 *   npx tsx scripts/run-batch.ts                     # new run
 *   npx tsx scripts/run-batch.ts --run 20260817-1200 # resume
 *   npx tsx scripts/run-batch.ts --static            # fixed LISTING_SLOTS instead
 *   npx tsx scripts/run-batch.ts --photos mug-ibm --slots main
 *   npx tsx scripts/run-batch.ts --sheet-only --run <id>
 */

import 'dotenv/config'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import path from 'node:path'
import sharp, { type OverlayOptions } from 'sharp'
import { extractImageDNA, type ImageDNA } from '../lib/claude/dna'
import { writePrompt } from '../lib/claude/prompt'
import { LISTING_SLOTS, type Slot } from '../lib/slots'
import { planShots, buildSlotSet, type ShotPlan } from '../lib/claude/shot-plan'
import { geminiGenerator } from '../lib/generators/gemini'
import { openai15Generator, openai2Generator } from '../lib/generators/openai'
import type { ImageGenerator } from '../lib/generators/types'
import { claudeCostUsd, usd } from '../lib/cost'
import { checkCompliance } from '../lib/compliance'
import { validateEnv, enabledGenerators, type GeneratorId } from '../lib/config'

const REGISTRY: Record<GeneratorId, ImageGenerator> = {
  gemini: geminiGenerator,
  'openai-1-5': openai15Generator,
  'openai-2': openai2Generator,
}
const GENERATORS: ImageGenerator[] = enabledGenerators().map((id) => REGISTRY[id])
const CONCURRENCY = 2

type Cell = {
  photo: string
  slotId: string
  generatorId: string
  file?: string
  error?: string
  costUsd: number
  ms: number
  retries: number
}

type Manifest = {
  runId: string
  startedAt: string
  photos: Record<string, { dna: ImageDNA; dnaCostUsd: number }>
  prompts: Record<string, { prompt: string; hintHandling: string; costUsd: number }>
  plans?: Record<string, { plan: ShotPlan; planCostUsd: number }>
  cells: Cell[]
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items]
  await Promise.all(
    Array.from({ length: Math.min(limit, queue.length) }, async () => {
      for (;;) {
        const item = queue.shift()
        if (item === undefined) return
        await fn(item)
      }
    }),
  )
}

async function loadManifest(dir: string, runId: string): Promise<Manifest> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'))
  } catch {
    return {
      runId,
      startedAt: new Date().toISOString(),
      photos: {},
      prompts: {},
      cells: [],
    }
  }
}

async function save(dir: string, m: Manifest) {
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2))
}

async function main() {
  const env = validateEnv()
  if (!env.ok) {
    console.error(`Missing env: ${env.missing.join(', ')}`)
    process.exit(1)
  }

  const runId =
    arg('run') ??
    new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
  const dir = path.join(process.cwd(), 'runs', runId)
  await mkdir(dir, { recursive: true })

  const manifest = await loadManifest(dir, runId)

  const photoFilter = arg('photos')?.split(',')
  const slotFilter = arg('slots')?.split(',')

  const allPhotos = (await readdir('test-photos'))
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .filter((f) => !photoFilter || photoFilter.some((p) => f.startsWith(p)))
  // Per-product shot planning is the default: a fixed slot list cannot be right for
  // every product. --static falls back to LISTING_SLOTS for comparison runs.
  const usePlan = !flag('static')
  const staticSlots = LISTING_SLOTS.filter((s) => !slotFilter || slotFilter.includes(s.id))

  if (flag('sheet-only')) {
    await contactSheets(dir, manifest, allPhotos)
    return
  }

  console.log(
    `run ${runId} — ${allPhotos.length} photo(s) × ${usePlan ? "planned" : staticSlots.length} slot(s)` +
      ` × ${GENERATORS.length} generator(s)${usePlan ? "  [per-product shot plan]" : ""}
`,
  )

  for (const photoFile of allPhotos) {
    const slug = path.parse(photoFile).name
    const buf = await readFile(path.join('test-photos', photoFile))
    const refImage = {
      data: buf.toString('base64'),
      mediaType: photoFile.endsWith('.png') ? 'image/png' : 'image/jpeg',
    }

    // --- Visual DNA, once per photo (cached across resumes) ---
    if (!manifest.photos[slug]) {
      process.stdout.write(`[${slug}] visual DNA … `)
      const { dna, usage } = await extractImageDNA(refImage)
      const cost = claudeCostUsd(usage)
      manifest.photos[slug] = { dna, dnaCostUsd: cost }
      await save(dir, manifest)
      console.log(`${dna.product} (${usd(cost)})`)
    } else {
      console.log(`[${slug}] visual DNA … cached`)
    }
    const { dna } = manifest.photos[slug]

    // --- shot plan, once per photo (cached across resumes) ---
    let slots: Slot[] = staticSlots
    if (usePlan) {
      manifest.plans ??= {}
      if (!manifest.plans[slug]) {
        process.stdout.write(`[${slug}] shot plan … `)
        const { plan, usage } = await planShots(dna)
        const cost = claudeCostUsd(usage)
        manifest.plans[slug] = { plan, planCostUsd: cost }
        await save(dir, manifest)
        console.log(`${plan.shots.length} shot(s) proposed (${usd(cost)})`)
      }
      const built = buildSlotSet(manifest.plans[slug].plan, dna, {
        allowCompose: flag('allow-compose') || process.env.ALLOW_COMPOSE === 'true',
      })
      slots = built.slots.filter((s) => !slotFilter || slotFilter.includes(s.id))
      if (built.deferred.length) {
        console.log(
          `  needs a real photo, not generated: ${built.deferred.map((d) => d.id).join(', ')}`,
        )
      }
    }

    for (const slot of slots) {
      const key = `${slug}:${slot.id}`

      // --- prompt, once per (photo, slot) ---
      if (!manifest.prompts[key]) {
        process.stdout.write(`  ${slot.label} prompt … `)
        const { result, usage } = await writePrompt({ dna, slot })
        const cost = claudeCostUsd(usage)
        manifest.prompts[key] = {
          prompt: result.prompt,
          hintHandling: result.hintHandling,
          costUsd: cost,
        }
        await save(dir, manifest)
        console.log(`${usd(cost)} (hint: ${result.hintHandling})`)
      }
      const { prompt } = manifest.prompts[key]

      // --- generators, skipping cells already done ---
      const todo = GENERATORS.filter(
        (g) =>
          !manifest.cells.some(
            (c) =>
              c.photo === slug &&
              c.slotId === slot.id &&
              c.generatorId === g.id &&
              !c.error,
          ),
      )
      if (!todo.length) {
        console.log(`  ${slot.label} images … cached`)
        continue
      }

      await pool(todo, CONCURRENCY, async (gen) => {
        const label = `  ${slot.label} / ${gen.label}`
        try {
          const r = await gen.generate(prompt, refImage, slot.renderMode)
          const ext = r.mimeType.includes('jpeg') ? 'jpg' : 'png'
          const file = `${slug}-${slot.id}-${gen.id}.${ext}`
          await writeFile(path.join(dir, file), Buffer.from(r.imageBase64, 'base64'))
          manifest.cells = manifest.cells.filter(
            (c) => !(c.photo === slug && c.slotId === slot.id && c.generatorId === gen.id),
          )
          manifest.cells.push({
            photo: slug,
            slotId: slot.id,
            generatorId: gen.id,
            file,
            costUsd: r.costUsd,
            ms: r.ms,
            retries: r.retries,
          })
          await save(dir, manifest)
          console.log(`${label} … ${(r.ms / 1000).toFixed(0)}s ${usd(r.costUsd)}`)
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          manifest.cells.push({
            photo: slug,
            slotId: slot.id,
            generatorId: gen.id,
            error: message,
            costUsd: 0,
            ms: 0,
            retries: 0,
          })
          await save(dir, manifest)
          console.log(`${label} … FAIL ${message.slice(0, 120)}`)
        }
      })
    }
  }

  await contactSheets(dir, manifest, allPhotos)
  await summarise(dir, manifest)
}

/** One sheet per product: rows = slots, columns = generators, source photo top-left. */
async function contactSheets(dir: string, m: Manifest, photos: string[]) {
  const CELL = 320
  const PAD = 8

  for (const photoFile of photos) {
    const slug = path.parse(photoFile).name
    const cells = m.cells.filter((c) => c.photo === slug)
    if (!cells.length) continue

    const slotIds = LISTING_SLOTS.map((s) => s.id).filter((id) =>
      cells.some((c) => c.slotId === id),
    )
    const genIds = GENERATORS.map((g) => g.id)

    const cols = genIds.length + 1 // +1 for the source photo column
    const rows = slotIds.length
    const width = cols * CELL + (cols + 1) * PAD
    const height = rows * CELL + (rows + 1) * PAD

    const composites: OverlayOptions[] = []

    const src = await sharp(path.join('test-photos', photoFile))
      .resize(CELL, CELL, { fit: 'contain', background: '#ffffff' })
      .png()
      .toBuffer()
    composites.push({ input: src, left: PAD, top: PAD })

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < genIds.length; c++) {
        const cell = cells.find(
          (x) => x.slotId === slotIds[r] && x.generatorId === genIds[c] && x.file,
        )
        if (!cell?.file) continue
        const buf = await sharp(path.join(dir, cell.file))
          .resize(CELL, CELL, { fit: 'contain', background: '#ffffff' })
          .png()
          .toBuffer()
        composites.push({
          input: buf,
          left: (c + 1) * (CELL + PAD) + PAD,
          top: r * (CELL + PAD) + PAD,
        })
      }
    }

    const out = path.join(dir, `sheet-${slug}.png`)
    await sharp({
      create: { width, height, channels: 3, background: '#e8e8e8' },
    })
      .composite(composites)
      .png()
      .toFile(out)

    console.log(
      `sheet → ${path.relative(process.cwd(), out)}  ` +
        `(col 1 = source, then ${genIds.join(', ')}; rows ${slotIds.join(', ')})`,
    )
  }
}

/** The numbers spec §8 asks to report back. */
async function summarise(dir: string, m: Manifest) {
  const claudeCost =
    Object.values(m.photos).reduce((s, p) => s + p.dnaCostUsd, 0) +
    Object.values(m.plans ?? {}).reduce((s, p) => s + p.planCostUsd, 0) +
    Object.values(m.prompts).reduce((s, p) => s + p.costUsd, 0)

  const byGen: Record<string, { usd: number; n: number; ms: number; fails: number }> = {}
  for (const c of m.cells) {
    const row = (byGen[c.generatorId] ??= { usd: 0, n: 0, ms: 0, fails: 0 })
    row.usd += c.costUsd
    row.ms += c.ms
    if (c.error) row.fails++
    else row.n++
  }

  const lines: string[] = ['', '=== run summary ===', `claude   ${usd(claudeCost)}`]
  let total = claudeCost
  for (const [id, r] of Object.entries(byGen)) {
    total += r.usd
    lines.push(
      `${id.padEnd(9)}${usd(r.usd)}  ${r.n} ok / ${r.fails} fail  avg ${(
        r.ms / Math.max(r.n, 1) / 1000
      ).toFixed(0)}s`,
    )
  }
  lines.push(`TOTAL    ${usd(total)}`)

  // Main-slot compliance, the one thing measurable without a human.
  const mains = m.cells.filter((c) => c.slotId === 'main' && c.file)
  if (mains.length) {
    lines.push('', '=== main slot compliance ===')
    for (const c of mains) {
      const rep = await checkCompliance(await readFile(path.join(dir, c.file!)))
      lines.push(
        `${c.photo}/${c.generatorId}`.padEnd(28) +
          `bgdev ${String(rep.bgMaxDeviation).padEnd(4)} ` +
          `fill ${String(rep.fillLinearPct).padEnd(6)} ` +
          (rep.touchesEdge ? 'CROPPED ' : '') +
          (rep.amazonReady ? 'amazon ready' : 'not compliant'),
      )
    }
  }

  const text = lines.join('\n')
  console.log(text)
  await writeFile(path.join(dir, 'summary.txt'), text.trimStart())
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
