/**
 * Build step 3 verification: run Visual DNA extraction against a real photo and print
 * the result, so the object can be eyeballed before anything is built on top of it.
 *
 *   npx tsx scripts/verify-dna.ts [test-photos/mug-ibm.jpg]
 */

import 'dotenv/config'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { extractImageDNA, renderDNA } from '../lib/claude/dna'
import { claudeCostUsd, usd } from '../lib/cost'
import { validateEnv } from '../lib/config'

const MEDIA: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

async function main() {
  const env = validateEnv()
  if (!env.ok) {
    console.error(`Missing env: ${env.missing.join(', ')}`)
    process.exit(1)
  }

  const file = process.argv[2] ?? 'test-photos/mug-ibm.jpg'
  const buf = await readFile(path.resolve(file))
  const mediaType = MEDIA[path.extname(file).toLowerCase()]
  if (!mediaType) throw new Error(`Unsupported extension for ${file}`)

  console.log(`Photo: ${file} (${(buf.length / 1024).toFixed(0)} KB)\n`)

  const { dna, usage, ms } = await extractImageDNA({
    data: buf.toString('base64'),
    mediaType,
  })

  console.log(renderDNA(dna))
  console.log('\n--- raw ---')
  console.log(JSON.stringify(dna, null, 2))
  console.log(
    `\n${(ms / 1000).toFixed(1)}s | in ${usage.input_tokens} / out ${usage.output_tokens} tok | ${usd(
      claudeCostUsd(usage),
    )}`,
  )
}

main().catch((err) => {
  console.error('\nFAILED:', err instanceof Error ? err.message : err)
  process.exit(1)
})
