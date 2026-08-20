/**
 * Run artifact storage.
 *
 * Three-way adapter: local disk in dev, Vercel Blob when a token is present, no-op
 * otherwise (so a deployed instance without Blob configured still works).
 *
 * The UI never depends on this — images always return to the browser as data URLs.
 * Storage exists so the test run leaves behind the raw material for the report to
 * Vishnu (spec §8).
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'

const RUNS_DIR = path.join(process.cwd(), 'runs')

type Mode = 'disk' | 'blob' | 'none'

function mode(): Mode {
  if (process.env.BLOB_READ_WRITE_TOKEN) return 'blob'
  // Vercel's filesystem is read-only apart from /tmp, so disk only makes sense locally.
  if (!process.env.VERCEL) return 'disk'
  return 'none'
}

export function newRunId(): string {
  const now = new Date()
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '')
  const rand = Math.random().toString(36).slice(2, 6)
  return `${stamp}-${rand}`
}

export async function saveImage(
  runId: string,
  name: string,
  base64: string,
  mimeType: string,
): Promise<string | null> {
  const ext = mimeType.includes('jpeg') ? 'jpg' : mimeType.includes('webp') ? 'webp' : 'png'
  const filename = `${name}.${ext}`
  const bytes = Buffer.from(base64, 'base64')

  switch (mode()) {
    case 'disk': {
      const dir = path.join(RUNS_DIR, runId)
      await mkdir(dir, { recursive: true })
      const file = path.join(dir, filename)
      await writeFile(file, bytes)
      return path.relative(process.cwd(), file)
    }
    case 'blob': {
      const { put } = await import('@vercel/blob')
      const res = await put(`${runId}/${filename}`, bytes, {
        access: 'public',
        contentType: mimeType,
      })
      return res.url
    }
    default:
      return null
  }
}

/** Appends to the run's record rather than overwriting, so partial runs stay useful. */
export async function appendRunRecord(
  runId: string,
  entry: Record<string, unknown>,
): Promise<void> {
  if (mode() !== 'disk') return
  const dir = path.join(RUNS_DIR, runId)
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, 'run.json')

  let existing: { runId: string; entries: unknown[] } = { runId, entries: [] }
  try {
    existing = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    // first write for this run
  }
  existing.entries.push({ at: new Date().toISOString(), ...entry })
  await writeFile(file, JSON.stringify(existing, null, 2))
}
