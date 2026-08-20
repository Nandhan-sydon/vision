/**
 * Diagnostic: does `images.edit` structurally prevent a pose change?
 *
 * Runs the SAME Claude-written Angle 2 prompt three ways on gpt-image-1.5:
 *   edit-lo   images.edit, input_fidelity 'low'  (what V1 does today, by default)
 *   edit-hi   images.edit, input_fidelity 'high'
 *   generate  images.generate — NO reference image, so nothing to anchor the pose to
 *
 * If only `generate` rotates, the reference image is the constraint and the fix is
 * architectural, not a prompt tweak.
 */
import 'dotenv/config'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import OpenAI, { toFile } from 'openai'
import path from 'node:path'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 })
const OUT = 'runs/exp-angle'

async function main() {
  const m = JSON.parse(await readFile('runs/mug-full/manifest.json', 'utf8'))
  const prompt: string = m.prompts['mug-ibm:angle-2'].prompt
  await mkdir(OUT, { recursive: true })

  const raw = await readFile('test-photos/mug-ibm.jpg')
  const mode = process.argv[2] ?? 'generate'

  const started = Date.now()
  let b64: string | undefined

  if (mode === 'generate') {
    const r = await client.images.generate({
      model: 'gpt-image-1.5',
      prompt,
      size: '1024x1024',
      quality: 'high',
    })
    b64 = r.data?.[0]?.b64_json
  } else {
    const file = await toFile(raw, 'reference.jpg', { type: 'image/jpeg' })
    const r = await client.images.edit({
      model: 'gpt-image-1.5',
      image: file,
      prompt,
      size: '1024x1024',
      quality: 'high',
      input_fidelity: mode === 'edit-hi' ? 'high' : 'low',
    })
    b64 = r.data?.[0]?.b64_json
  }

  if (!b64) throw new Error('no image returned')
  const out = path.join(OUT, `${mode}.png`)
  await writeFile(out, Buffer.from(b64, 'base64'))
  console.log(`${mode} … ${((Date.now() - started) / 1000).toFixed(0)}s → ${out}`)
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1) })
