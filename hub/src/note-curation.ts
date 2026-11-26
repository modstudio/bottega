// concern: note curation
/** Runs bounded schema-backed curator pages and validates their proposals. */

import { z } from 'zod'
import type { NoteEvaluationCluster } from './note-evaluation.ts'
import {
  type ClassProposal,
  type CuratorNote,
  type NoteProposal,
  packCuratorPages,
  rankNoteClasses,
  type RankedClass,
  type SeedClass,
} from './note-curation-decisions.ts'
import {
  type CuratorRunReply,
  dispatchNoteEvaluationCurator,
} from './note-curator-orch.ts'

const CURATOR_PAGE_CONCURRENCY = 2

const ClassProposalSchema = z.union([
  z.object({ seed: z.string().min(1) }).strict(),
  z
    .object({ proposed: z.object({ name: z.string().min(1), definition: z.string().min(1) }).strict() })
    .strict(),
])
const CuratorReplySchema = z
  .object({
    proposals: z.array(
      z
        .object({
          label: z.string().min(1),
          class: ClassProposalSchema,
          duplicate_of: z.string().nullable(),
          still_holds: z.enum(['yes', 'no', 'unsure']),
          reason: z.string().min(1),
        })
        .strict(),
    ),
  })
  .strict()

export type FailedCuratorPage = {
  page: number
  labels: string[]
  runId: string | null
  error: string
}

export type NoteCurationResult = {
  proposals: NoteProposal[]
  failedPages: FailedCuratorPage[]
  invalidEntries: number
  stopped: string | null
  ranking: RankedClass[]
}

function curatorPrompt(seed: readonly SeedClass[], notes: readonly CuratorNote[]): string {
  const vocabulary = seed
    .map(({ code, name, definition }) => `- ${code}: ${name} — ${definition}`)
    .join('\n')
  const page = notes.map(({ label, text }) => `### ${label}\n${text}`).join('\n\n')
  return `Propose a disposition for every defect note below. These are proposals only: do not change notes or tasks. Use a seed class when it fits; otherwise propose one class name and one-line definition. duplicate_of may name only another label on this page. Return only the schema-bound reply.\n\nSeed classes:\n${vocabulary}\n\nNotes:\n${page}`
}

function checkedPageProposals(
  raw: unknown,
  page: readonly CuratorNote[],
  seed: readonly SeedClass[],
): { proposals: NoteProposal[]; invalid: number } {
  const parsed = CuratorReplySchema.parse(raw)
  const labels = new Set(page.map(({ label }) => label))
  const seedCodes = new Set(seed.map(({ code }) => code))
  const seen = new Set<string>()
  const proposals: NoteProposal[] = []
  let invalid = 0
  for (const entry of parsed.proposals) {
    if (seen.has(entry.label) || !labels.has(entry.label)) {
      invalid++
      continue
    }
    seen.add(entry.label)
    if ('seed' in entry.class && !seedCodes.has(entry.class.seed)) {
      invalid++
      continue
    }
    let duplicateOf = entry.duplicate_of
    if (duplicateOf !== null && !labels.has(duplicateOf)) {
      invalid++
      duplicateOf = null
    }
    proposals.push({
      label: entry.label,
      class: entry.class as ClassProposal,
      duplicate_of: duplicateOf,
      still_holds: entry.still_holds,
      reason: entry.reason,
      source: 'curator',
    })
  }
  invalid += page.filter(({ label }) => !seen.has(label)).length
  return { proposals, invalid }
}

type Dispatch = (cwd: string, prompt: string) => Promise<CuratorRunReply>

async function curatePage(
  page: readonly CuratorNote[],
  pageNumber: number,
  cwd: string,
  seed: readonly SeedClass[],
  dispatch: Dispatch,
): Promise<
  | { kind: 'ok'; proposals: NoteProposal[]; invalid: number }
  | { kind: 'failed'; failure: FailedCuratorPage }
> {
  let runId: string | null = null
  try {
    const result = await dispatch(cwd, curatorPrompt(seed, page))
    runId = result.runId
    const checked = checkedPageProposals(result.reply, page, seed)
    return { kind: 'ok', ...checked }
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause)
    const referenced = /^r[1-9][0-9]*/.exec(error)?.[0]
    return {
      kind: 'failed',
      failure: { page: pageNumber, labels: page.map(({ label }) => label), runId: runId ?? referenced ?? null, error },
    }
  }
}

async function mapPages(
  pages: readonly CuratorNote[][],
  cwd: string,
  seed: readonly SeedClass[],
  dispatch: Dispatch,
) {
  const results = new Array<Awaited<ReturnType<typeof curatePage>>>(pages.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < pages.length) {
      const index = cursor++
      results[index] = await curatePage(pages[index]!, index + 2, cwd, seed, dispatch)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CURATOR_PAGE_CONCURRENCY, pages.length) }, worker))
  return results
}

export async function curateEvaluationNotes(
  cwd: string,
  allNotes: readonly CuratorNote[],
  notes: readonly CuratorNote[],
  clusters: readonly NoteEvaluationCluster[],
  seed: readonly SeedClass[],
  dispatch: Dispatch = dispatchNoteEvaluationCurator,
): Promise<NoteCurationResult> {
  const pages = packCuratorPages(notes, clusters)
  if (!pages.length)
    return { proposals: [], failedPages: [], invalidEntries: 0, stopped: null, ranking: [] }
  const first = await curatePage(pages[0]!, 1, cwd, seed, dispatch)
  if (first.kind === 'failed') {
    const refusal = first.failure.runId === null ? first.failure.error : null
    if (refusal)
      return {
        proposals: [],
        failedPages: [first.failure],
        invalidEntries: 0,
        stopped: refusal,
        ranking: [],
      }
  }
  const rest = await mapPages(pages.slice(1), cwd, seed, dispatch)
  const results = [first, ...rest]
  const proposals = results.flatMap((result) => (result.kind === 'ok' ? result.proposals : []))
  return {
    proposals,
    failedPages: results.flatMap((result) => (result.kind === 'failed' ? [result.failure] : [])),
    invalidEntries: results.reduce(
      (sum, result) => sum + (result.kind === 'ok' ? result.invalid : 0),
      0,
    ),
    stopped: null,
    ranking: rankNoteClasses(allNotes, proposals, seed),
  }
}

