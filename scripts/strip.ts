import sharp, { type OverlayOptions } from 'sharp'
import path from 'node:path'

const CELL = 340, PAD = 6
async function main() {
  const files = process.argv.slice(2)
  const comps: OverlayOptions[] = []
  for (let i = 0; i < files.length; i++) {
    const buf = await sharp(files[i])
      .resize(CELL, CELL, { fit: 'contain', background: '#ffffff' })
      .png().toBuffer()
    comps.push({ input: buf, left: i * (CELL + PAD) + PAD, top: PAD })
  }
  const out = 'runs/exp-angle/comparison.png'
  await sharp({ create: {
    width: files.length * (CELL + PAD) + PAD, height: CELL + PAD * 2,
    channels: 3, background: '#d0d0d0' } })
    .composite(comps).png().toFile(out)
  console.log(out, '=', files.map((f) => path.basename(f)).join(' | '))
}
main()
