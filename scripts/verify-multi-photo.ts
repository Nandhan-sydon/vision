/**
 * Coverage and routing across a photo set — no images generated, so it costs two Claude
 * calls and can be run freely.
 *
 *   npx tsx scripts/verify-multi-photo.ts test-photos/sets/cricket-bat
 *   npx tsx scripts/verify-multi-photo.ts --derive mug-ibm
 *
 * This is the stage that decides what will NOT be generated, so it is worth being able to
 * read it directly. It prints, per shot: which photo it will be rendered from, whether the
 * camera has to move to a viewpoint nothing supplies, and — for the shots held back — the
 * photograph the seller needs to take.
 *
 * ## On --derive, and what it does and does not prove
 *
 * The repo's test photos are single frames, and genuine multi-view sets of one physical
 * object are not something Wikimedia reliably has. `--derive` builds a set from one photo
 * by cropping regions of it, so the frames are honestly different framings of the same
 * real object with no pixel invented.
 *
 * What that exercises is real: the fingerprint has to describe each frame separately, the
 * planner has to route each shot to the frame that actually shows its surface, and shots
 * needing a surface no crop contains still have to be refused.
 *
 * What it does NOT exercise is the reason multi-photo exists — a crop is not a new camera
 * angle, so every derived frame shares one viewpoint. The claim that several angles remove
 * the pose problem can only be tested on a real set. Point this script at one.
 */

import 'dotenv/config'
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'
import { extractImageDNA, renderCoverage } from '../lib/claude/dna'
import { planShots, buildSlotSet, renderPlan } from '../lib/claude/shot-plan'
import { claudeCostUsd, usd } from '../lib/cost'
import { validateEnv } from '../lib/config'
import { MAX_PHOTOS, photoLabel, type Base64Image } from '../lib/photos'

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
    entries.map(async (f) => {
      const buf = await readFile(path.join(dir, f))
      return {
        data: buf.toString('base64'),
        mediaType: MEDIA[path.extname(f).toLowerCase()],
      }
    }),
  )
  return { photos, names: entries }
}

/**
 * Build a set of real crops from one photo and write it to disk, so the same set can be
 * re-inspected and eyeballed rather than existing only inside this process.
 */
async function derive(slug: string): Promise<{ dir: string }> {
  const src = path.resolve(`test-photos/${slug}.jpg`)
  const dir = path.resolve(`test-photos/sets/${slug}-derived`)
  await mkdir(dir, { recursive: true })

  const meta = await sharp(src).metadata()
  const w = meta.width ?? 1000
  const h = meta.height ?? 1000

  const regions: { name: string; left: number; top: number; width: number; height: number }[] = [
    { name: '1-full', left: 0, top: 0, width: w, height: h },
    {
      name: '2-upper',
      left: Math.round(w * 0.1),
      top: 0,
      width: Math.round(w * 0.8),
      height: Math.round(h * 0.55),
    },
    {
      name: '3-lower',
      left: Math.round(w * 0.1),
      top: Math.round(h * 0.45),
      width: Math.round(w * 0.8),
      height: Math.round(h * 0.55),
    },
    {
      name: '4-centre-macro',
      left: Math.round(w * 0.28),
      top: Math.round(h * 0.28),
      width: Math.round(w * 0.44),
      height: Math.round(h * 0.44),
    },
  ]

  for (const r of regions) {
    const buf = await sharp(src)
      .extract({ left: r.left, top: r.top, width: r.width, height: r.height })
      .jpeg({ quality: 92 })
      .toBuffer()
    await writeFile(path.join(dir, `${r.name}.jpg`), buf)
  }
  return { dir }
}

async function main() {
  const env = validateEnv()
  if (!env.ok) {
    console.error(`Missing env: ${env.missing.join(', ')}`)
    process.exit(1)
  }

  let dir = process.argv.slice(2).find((a) => !a.startsWith('--'))

  if (flag('derive')) {
    const slug = arg('derive') ?? 'mug-ibm'
    const built = await derive(slug)
    dir = built.dir
    console.log(`Derived a crop set from test-photos/${slug}.jpg into ${dir}`)
    console.log(
      'These are crops of one frame, not new camera angles. They test coverage routing;\n' +
        'they cannot test whether several real angles remove the pose problem.\n',
    )
  }

  if (!dir) {
    console.error(
      'Usage: verify-multi-photo.ts <dir-of-photos> | --derive <slug>\n' +
        'Point it at a directory of real photos of one product for a meaningful result.',
    )
    process.exit(1)
  }

  const { photos, names } = await loadDir(dir)
  console.log(`${photos.length} photo(s) from ${dir}:`)
  names.forEach((n, i) => console.log(`  ${photoLabel(i)} = ${n}`))
  console.log()

  let total = 0

  process.stdout.write('Fingerprint across the whole set … ')
  const { dna, usage: dnaUsage, ms: dnaMs } = await extractImageDNA(photos)
  const dnaCost = claudeCostUsd(dnaUsage)
  total += dnaCost
  console.log(`${dna.product} (${(dnaMs / 1000).toFixed(1)}s, ${usd(dnaCost)})\n`)

  console.log('--- coverage ---')
  console.log(renderCoverage(dna))
  console.log()

  process.stdout.write('Shot plan … ')
  const { plan, usage: planUsage, ms: planMs } = await planShots(dna)
  const planCost = claudeCostUsd(planUsage)
  total += planCost
  console.log(`${plan.shots.length} shot(s) (${(planMs / 1000).toFixed(1)}s, ${usd(planCost)})\n`)

  const set = buildSlotSet(plan, dna)

  console.log('--- plan ---')
  console.log(renderPlan(plan, set))
  console.log()

  // The numbers worth watching across runs. A set that routes everything to Photo 1 is a
  // set the planner is not really using, and it will look like success in the shot list.
  const routed = set.slots.filter((s) => (s.sourcePhotos?.length ?? 0) > 0)
  const distinct = new Set(set.slots.flatMap((s) => s.sourcePhotos ?? []))
  const kinds = new Set(set.slots.map((s) => s.kind ?? 'angle'))

  console.log('--- summary ---')
  console.log(`generated shots      : ${set.slots.length}`)
  console.log(`deferred to seller   : ${set.deferrals.length}`)
  console.log(`routed to a photo    : ${routed.length}/${set.slots.length}`)
  console.log(
    `distinct photos used : ${distinct.size}/${photos.length}` +
      (distinct.size <= 1 && photos.length > 1
        ? '   ← every shot routed to one photo; the extra photos are not being used'
        : ''),
  )
  console.log(`shot kinds           : ${[...kinds].join(', ')}`)
  console.log(
    `in-use shot planned  : ${kinds.has('in-use') ? 'yes' : 'no'}` +
      (kinds.has('in-use') ? '' : '   ← check whether this product genuinely has no in-use shot'),
  )
  console.log(`surfaces no photo shows: ${dna.absentSurfaces.length}`)
  console.log(`\ntotal ${usd(total)}`)
}

main().catch((e) => {
  console.error('FAILED:', e instanceof Error ? e.message : e)
  process.exit(1)
})
