/**
 * Deterministic main-image checks against Amazon's published rules.
 *
 *   npx tsx scripts/check-compliance.ts runs/mug-full
 *   npx tsx scripts/check-compliance.ts runs/mug-full --snap
 *
 * --snap also writes a white-point-corrected copy alongside each image and re-checks it,
 * showing whether the only thing standing between the output and compliance was the
 * background not being mathematically pure white.
 */

import { readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { checkCompliance, type ComplianceReport } from '../lib/compliance'
import { snapWhitePoint } from '../lib/postprocess'

async function expand(target: string): Promise<string[]> {
  const s = await stat(target).catch(() => null)
  if (!s) return []
  if (s.isDirectory()) {
    const names = await readdir(target)
    return names
      .filter((n) => /\.(png|jpe?g|webp)$/i.test(n) && !n.includes('.snapped.'))
      .map((n) => path.join(target, n))
  }
  return [target]
}

function verdict(r: ComplianceReport): string {
  if (r.amazonReady) return 'AMAZON READY'
  const fails: string[] = []
  if (!r.passes.exactlyPureWhite) fails.push(r.passes.visuallyWhite ? 'white(not exact)' : 'WHITE')
  if (!r.passes.frameFill) fails.push('FILL')
  if (!r.passes.notCropped) fails.push('CROPPED')
  if (!r.passes.resolutionMinimum) fails.push('RES')
  return fails.join(' ')
}

function row(name: string, r: ComplianceReport): string {
  return (
    name.slice(0, 27).padEnd(28) +
    `${r.width}x${r.height}`.padEnd(11) +
    `${r.bgMaxDeviation}`.padEnd(7) +
    `${r.fillLinearPct}`.padEnd(7) +
    (r.touchesEdge ? 'yes' : 'no').padEnd(6) +
    verdict(r)
  )
}

async function main() {
  const args = process.argv.slice(2)
  const snap = args.includes('--snap')
  const targets = args.filter((a) => !a.startsWith('--'))
  if (!targets.length) {
    console.error('usage: npx tsx scripts/check-compliance.ts <file|dir> [...] [--snap]')
    process.exit(1)
  }

  const files = (await Promise.all(targets.map(expand))).flat()
  if (!files.length) {
    console.error('No images found.')
    process.exit(1)
  }

  const head =
    'image'.padEnd(28) + 'size'.padEnd(11) + 'bgdev'.padEnd(7) + 'fill%'.padEnd(7) +
    'crop'.padEnd(6) + 'verdict'
  console.log(head)
  console.log('-'.repeat(head.length + 8))

  let ready = 0
  let readyAfterSnap = 0

  for (const file of files.sort()) {
    const buf = await readFile(file)
    const r = await checkCompliance(buf)
    if (r.amazonReady) ready++
    console.log(row(path.basename(file), r))
    for (const note of r.notes) console.log(`${' '.repeat(28)}↳ ${note}`)

    if (snap && !r.passes.exactlyPureWhite) {
      const { buffer, changedPct, maxCorrection } = await snapWhitePoint(buf)
      const out = file.replace(/\.(png|jpe?g|webp)$/i, '.snapped.png')
      await writeFile(out, buffer)
      const after = await checkCompliance(buffer)
      if (after.amazonReady) readyAfterSnap++
      console.log(
        row(`  ↳ ${path.basename(out)}`, after) +
          `   (${changedPct}% of pixels, max ${maxCorrection}/255)`,
      )
    }
  }

  console.log(
    `\n${ready}/${files.length} Amazon-ready as generated` +
      (snap ? `, ${ready + readyAfterSnap}/${files.length} after white-point snap` : ''),
  )
  console.log(
    '\nbgdev  largest per-channel shortfall from 255 in the background (Amazon needs 0)\n' +
      'fill%  product bounding box on its larger axis (Amazon needs >= 85, no upper bound)\n' +
      'crop   product touching a frame edge — a hard fail regardless of fill',
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
