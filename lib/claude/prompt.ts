/**
 * Stage 2 — prompt writing.
 *
 * Takes the Visual DNA, the slot definition, the reference photos that slot is routed to,
 * and an optional user hint, and returns the single prompt that goes to every image
 * generator. The user never sees this and never writes it (spec §2).
 *
 * Also the rewrite stage. When the reviewer rejects an image, the same writer produces the
 * next prompt with the review attached, rather than a second component owning "fixing".
 * One writer means one place where the Visual DNA and the hard rules are enforced: a
 * separate patcher would have to re-derive both to avoid reintroducing a violation while
 * correcting an unrelated defect.
 */

import { CLAUDE_MAX_TOKENS, MODELS } from '../config'
import { slotHardRules, type Slot } from '../slots'
import { claude, firstText, parseJson } from './client'
import { renderDNA, type ImageDNA } from './dna'
import {
  PROMPT_WRITER_SYSTEM,
  buildPromptRequest,
  type PromptFeedback,
} from './system-prompts'
import { photoLabel } from '../photos'
import { resolveStyle, type ResolvedStyle } from '../style-grid'
import { productIdentity } from '../product-key'
import { rulesFor } from '../amazon/rules'
import { renderBuildMemory, type BuildMemory } from '../build-memory'
import type { ClaudeUsage } from '../cost'

export type { PromptFeedback }

export type HintHandling =
  | 'none'
  | 'incorporated'
  | 'partially-overridden'
  | 'rejected'

export type WrittenPrompt = {
  prompt: string
  hintHandling: HintHandling
}

const SCHEMA = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description:
        'The complete prompt for the image generator. No preamble or commentary.',
    },
    hintHandling: {
      type: 'string',
      enum: ['none', 'incorporated', 'partially-overridden', 'rejected'],
      description: 'How the user preference was treated. Logged, never shown to the user.',
    },
  },
  required: ['prompt', 'hintHandling'],
  additionalProperties: false,
} as const

export async function writePrompt(args: {
  dna: ImageDNA
  slot: Slot
  hint?: string
  /**
   * Photo indexes the generator will actually receive, in call order. Defaults to the
   * slot's own routing. Passed explicitly by the render loop, which has already resolved
   * the fallback for an unrouted slot and must not describe photos the generator will
   * not see.
   */
  referenceIndexes?: number[]
  /** What has already been generated for this product (spec §7, third input). */
  buildMemory?: BuildMemory
  /** A rejected previous attempt to rewrite from. Absent on the first attempt. */
  feedback?: PromptFeedback
}): Promise<{
  result: WrittenPrompt
  style: ResolvedStyle
  usage: ClaudeUsage
  ms: number
}> {
  const started = Date.now()

  const renderMode = args.slot.renderMode ?? 'edit'
  const isMain = args.slot.mode === 'locked'

  // Spec §7/§8. Resolved here rather than passed in, so every caller of the prompt writer
  // gets the same conditioning: a route that forgot to attach the style grid would produce
  // an undirected prompt that looks fine and drifts, which is the failure mode §7 names.
  const style = resolveStyle({
    kind: args.slot.kind ?? 'angle',
    isMain,
    productIdentityString: productIdentity(args.dna),
    shotId: args.slot.id,
  })

  const marketplaceRules = rulesFor({
    category: args.dna.amazonCategory,
    isMain,
  })
  const indexes = args.referenceIndexes ?? args.slot.sourcePhotos ?? []

  // The generator sees the references renumbered from 1 in call order, not by their
  // position in the seller's upload. Labelling them by upload position would have the
  // prompt say "Photo 4" about the image the generator received as its first, which is
  // worse than no label at all. `referenceNotes` carries what each one shows, from the
  // fingerprint, so the writer can say which reference is for the viewpoint and which is
  // for the surface.
  const referenceLabels = indexes.map((_, i) => photoLabel(i))
  const referenceNotes = indexes.map((index) => {
    const role = args.dna.photos.find((p) => p.index === index)
    if (!role) return ''
    const shows = role.shows.length ? `shows ${role.shows.join(', ')}` : ''
    return [role.viewpoint, shows].filter(Boolean).join('; ')
  })

  const response = await claude().messages.create({
    model: MODELS.claude,
    max_tokens: CLAUDE_MAX_TOKENS,
    system: PROMPT_WRITER_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [
      {
        role: 'user',
        content: buildPromptRequest({
          dnaText: renderDNA(args.dna),
          slotLabel: args.slot.label,
          kind: args.slot.kind ?? 'angle',
          directive: args.slot.directive,
          // The slot's own rules plus the invariants for its kind — an in-use shot's
          // anatomy and grip constraints are not restated per shot in the plan, so they
          // have to be merged in here or they reach no prompt at all.
          hardRules: slotHardRules(args.slot),
          hint: args.hint,
          renderMode,
          referenceLabels: renderMode === 'edit' ? referenceLabels : undefined,
          referenceNotes: renderMode === 'edit' ? referenceNotes : undefined,
          styleDirectives: style.directives,
          buildMemoryText: args.buildMemory
            ? renderBuildMemory(args.buildMemory, args.slot.id)
            : undefined,
          marketplaceRules,
          isMain,
          feedback: args.feedback,
        }),
      },
    ],
  })

  const result = parseJson<WrittenPrompt>(firstText(response), 'Prompt writing')
  // The resolved style comes back so the render loop can record it in build memory without
  // re-deriving it — re-deriving is where the recorded look and the actual look drift apart.
  return { result, style, usage: response.usage as ClaudeUsage, ms: Date.now() - started }
}
