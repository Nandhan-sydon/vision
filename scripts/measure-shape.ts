import sharp from 'sharp'
import path from 'node:path'

/** Bounding box of non-white content, and its height:width ratio. */
async function shape(file: string) {
  const { data, info } = await sharp(file)
    .flatten({ background: '#ffffff' })
    .raw()
    .toBuffer({ resolveWithObject: true })
  const { width, height, channels } = info
  let minX = width, minY = height, maxX = -1, maxY = -1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * channels
      if (data[i] < 240 || data[i + 1] < 240 || data[i + 2] < 240) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  const w = maxX - minX + 1
  const h = maxY - minY + 1
  return { file: path.basename(file), w, h, ratio: h / w }
}

async function main() {
  for (const f of process.argv.slice(2)) {
    const s = await shape(f)
    console.log(
      `${s.file.slice(0, 44).padEnd(46)} bbox ${String(s.w).padStart(4)}x${String(s.h).padStart(4)}  ` +
        `height:width = ${s.ratio.toFixed(2)}`,
    )
  }
}
main()
