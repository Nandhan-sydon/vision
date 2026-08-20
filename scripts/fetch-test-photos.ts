/**
 * Sources the test product photos (spec §8) from Wikimedia Commons.
 *
 * Four products spanning the categories the spec asks for:
 *   - rigid/simple with printed branding   → ceramic mug with a logo
 *   - reflective metal with fine dial text → stainless wristwatch
 *   - soft textured fabric                 → canvas backpack
 *   - mixed material, moulded plastic      → over-ear headphones
 *
 * Writes downscaled JPEGs to test-photos/ plus a licence manifest, since these are
 * third-party images and the run report should say where they came from.
 */

import { writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const UA = 'sydon-listing-poc/0.1 (internal PoC; contact nandhan@sydon.ai)'
const OUT = path.join(process.cwd(), 'test-photos')
const MAX_EDGE = 1400

const WANTED: { slug: string; title: string; note: string }[] = [
  {
    slug: 'mug-ibm',
    title: 'IBM merchandising coffee mug with company logo.jpg',
    note: 'rigid/simple, printed logo',
  },
  {
    slug: 'watch-fossil',
    title: 'Fossil wristwatch with white background.jpg',
    note: 'reflective metal, fine dial text',
  },
  {
    slug: 'backpack',
    title: 'Backpack small.jpg',
    note: 'soft fabric texture',
  },
  {
    slug: 'headphones-bose',
    title:
      'Bose QuietComfort 25 Acoustic Noise Cancelling Headphones with Carry Case.jpg',
    note: 'mixed material, moulded plastic, branding',
  },
]

type Info = {
  thumburl?: string
  url?: string
  descriptionurl?: string
  extmetadata?: Record<string, { value?: string }>
}

async function lookup(title: string): Promise<Info | null> {
  const url =
    'https://commons.wikimedia.org/w/api.php?action=query&format=json' +
    `&titles=${encodeURIComponent('File:' + title)}` +
    '&prop=imageinfo&iiprop=url|extmetadata&iiurlwidth=' +
    MAX_EDGE
  const res = await fetch(url, { headers: { 'User-Agent': UA } })
  if (!res.ok) return null
  const json = (await res.json()) as {
    query?: { pages?: Record<string, { imageinfo?: Info[] }> }
  }
  const pages = json.query?.pages ?? {}
  for (const key of Object.keys(pages)) {
    const info = pages[key].imageinfo?.[0]
    if (info) return info
  }
  return null
}

async function main() {
  await mkdir(OUT, { recursive: true })
  const manifest: Record<string, unknown>[] = []

  for (const item of WANTED) {
    process.stdout.write(`${item.slug} … `)
    const info = await lookup(item.title)
    const src = info?.thumburl ?? info?.url
    if (!src) {
      console.log('NOT FOUND')
      continue
    }

    const res = await fetch(src, { headers: { 'User-Agent': UA } })
    if (!res.ok) {
      console.log(`HTTP ${res.status}`)
      continue
    }

    const raw = Buffer.from(await res.arrayBuffer())
    const jpeg = await sharp(raw)
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 90 })
      .toBuffer()

    const file = path.join(OUT, `${item.slug}.jpg`)
    await writeFile(file, jpeg)

    const meta = await sharp(jpeg).metadata()
    console.log(`${meta.width}x${meta.height}, ${(jpeg.length / 1024).toFixed(0)} KB`)

    manifest.push({
      slug: item.slug,
      note: item.note,
      file: `test-photos/${item.slug}.jpg`,
      sourceTitle: item.title,
      sourcePage: info?.descriptionurl ?? null,
      licence: info?.extmetadata?.LicenseShortName?.value ?? 'see source page',
      artist: (info?.extmetadata?.Artist?.value ?? '').replace(/<[^>]+>/g, '').trim() || null,
    })
  }

  await writeFile(
    path.join(OUT, 'manifest.json'),
    JSON.stringify({ source: 'Wikimedia Commons', fetched: manifest }, null, 2),
  )
  console.log(`\n${manifest.length} photo(s) → test-photos/`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
