/**
 * Cost accounting (spec §8 asks for a per-vendor breakdown of the test run).
 *
 * Claude cost comes from the real `usage` on each response. Image cost comes from the
 * static table in config, except where a vendor returns token usage we can price
 * directly.
 */

import { PRICING, type GeneratorId } from './config'

export type ClaudeUsage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

export type CostEntry = {
  stage: 'visual-dna' | 'prompt' | 'image'
  vendor: 'claude' | GeneratorId
  usd: number
  ms: number
  detail?: Record<string, unknown>
}

/** Cached reads bill at ~0.1x input; cache writes at ~1.25x. */
export function claudeCostUsd(usage: ClaudeUsage): number {
  const { inputPerMTok, outputPerMTok } = PRICING.claude
  const input = usage.input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const output = usage.output_tokens ?? 0

  const inputUsd = (input / 1_000_000) * inputPerMTok
  const cacheReadUsd = (cacheRead / 1_000_000) * inputPerMTok * 0.1
  const cacheWriteUsd = (cacheWrite / 1_000_000) * inputPerMTok * 1.25
  const outputUsd = (output / 1_000_000) * outputPerMTok

  return inputUsd + cacheReadUsd + cacheWriteUsd + outputUsd
}

export function imageCostUsd(vendor: GeneratorId): number {
  return PRICING.images[vendor]
}

/** Accumulates every priced call in one run so the report writes itself. */
export class CostLedger {
  private entries: CostEntry[] = []

  add(entry: CostEntry): void {
    this.entries.push(entry)
  }

  addClaude(
    stage: 'visual-dna' | 'prompt',
    usage: ClaudeUsage,
    ms: number,
    detail?: Record<string, unknown>,
  ): number {
    const usd = claudeCostUsd(usage)
    this.entries.push({
      stage,
      vendor: 'claude',
      usd,
      ms,
      detail: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        ...detail,
      },
    })
    return usd
  }

  all(): CostEntry[] {
    return [...this.entries]
  }

  totalUsd(): number {
    return this.entries.reduce((sum, e) => sum + e.usd, 0)
  }

  /** Per-vendor breakdown — exactly the shape spec §8 asks to report back. */
  byVendor(): Record<string, { usd: number; calls: number; ms: number }> {
    const out: Record<string, { usd: number; calls: number; ms: number }> = {}
    for (const e of this.entries) {
      const row = (out[e.vendor] ??= { usd: 0, calls: 0, ms: 0 })
      row.usd += e.usd
      row.calls += 1
      row.ms += e.ms
    }
    return out
  }
}

export function usd(n: number): string {
  return `$${n.toFixed(4)}`
}
