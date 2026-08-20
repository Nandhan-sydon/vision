/**
 * Build steps 5-6 verification: call each image generator live with a hand-written
 * prompt and save what comes back.
 *
 * The prompt here stands in for Claude's output so the generators can be verified
 * independently of stages 1-2. It is deliberately written the way the prompt-writer is
 * instructed to write: Visual DNA preservation stated explicitly, Main-slot hard rules
 * folded in.
 *
 *   npx tsx scripts/verify-generators.ts              # all three
 *   npx tsx scripts/verify-generators.ts gemini       # just one
 */

import 'dotenv/config'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { geminiGenerator } from '../lib/generators/gemini'
import { openai15Generator, openai2Generator } from '../lib/generators/openai'
import type { ImageGenerator } from '../lib/generators/types'
import { usd } from '../lib/cost'
import { validateEnv } from '../lib/config'

const PROMPT = `A professional e-commerce catalogue photograph of a white glossy ceramic coffee mug with a D-shaped handle on the right.

Preserve the product exactly as it appears in the reference image: the same off-white glazed ceramic body with its subtly tapered cylindrical shape, the same D-shaped handle and its proportions, and above all the same blue horizontal-striped IBM wordmark printed on the front — identical letterforms, identical eight-bar striped construction, identical medium blue, identical size and position centred on the mug body. Do not redraw, restyle, re-space, or re-letter the logo. Do not add or remove any marking.

The background must be pure white, RGB(255,255,255), edge to edge, with no gradient, vignette, texture, or off-white tint. The mug must fill 85-90% of the frame, centred, shot straight on at eye level. No props, no surface, no table, no scenery, no hands, no packaging. No text, labels, badges, captions, or graphic overlays anywhere in the image. No watermark. Even, soft, shadowless studio lighting.`

const ALL: ImageGenerator[] = [geminiGenerator, openai15Generator, openai2Generator]

async function main() {
  const env = validateEnv()
  if (!env.ok) {
    console.error(`Missing env: ${env.missing.join(', ')}`)
    process.exit(1)
  }

  const filter = process.argv[2]
  const gens = filter ? ALL.filter((g) => g.id.includes(filter)) : ALL
  if (!gens.length) {
    console.error(`No generator matches "${filter}". Try: gemini, openai-1-5, openai-2`)
    process.exit(1)
  }

  const buf = await readFile(path.resolve('test-photos/mug-ibm.jpg'))
  const refImage = { data: buf.toString('base64'), mediaType: 'image/jpeg' }

  const outDir = path.join(process.cwd(), 'runs', 'verify-generators')
  await mkdir(outDir, { recursive: true })

  let total = 0
  for (const gen of gens) {
    process.stdout.write(`${gen.label.padEnd(20)} … `)
    try {
      const r = await gen.generate(PROMPT, refImage)
      const ext = r.mimeType.includes('jpeg') ? 'jpg' : 'png'
      const file = path.join(outDir, `${r.id}.${ext}`)
      await writeFile(file, Buffer.from(r.imageBase64, 'base64'))
      total += r.costUsd
      const kb = (Buffer.from(r.imageBase64, 'base64').length / 1024).toFixed(0)
      console.log(
        `OK  ${(r.ms / 1000).toFixed(1)}s  ${usd(r.costUsd)}  ${kb} KB` +
          (r.retries ? `  (${r.retries} retry)` : '') +
          `  → ${path.relative(process.cwd(), file)}`,
      )
    } catch (err) {
      console.log(`FAIL  ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  console.log(`\ntotal ${usd(total)}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
