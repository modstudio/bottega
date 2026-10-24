import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'

type RecordSource = 'score' | 'ruling' | 'review' | 'output'

type RecordSearchResult = {
  source: RecordSource
  id: number | string
  run_number: number
  run_record_id: string
  root_run_number: number
  root_run_record_id: string
  task_key: string | null
  started_at: string
  match: 'direct task link' | 'literal text match (weak relevance)'
  snippet: string
  content?: string
}

export type RecordSearch = {
  query: string
  results: RecordSearchResult[]
  unavailable_outputs: number
  truncated: boolean
}

type Candidate = Omit<RecordSearchResult, 'match' | 'snippet'> & { text: string }

const SNIPPET_LENGTH = 240

function matchedResult(row: Candidate, query: string, includeFull: boolean): RecordSearchResult {
  const directlyLinked = row.task_key?.toLocaleLowerCase() === query.toLocaleLowerCase()
  return {
    source: row.source,
    id: row.id,
    run_number: row.run_number,
    run_record_id: row.run_record_id,
    root_run_number: row.root_run_number,
    root_run_record_id: row.root_run_record_id,
    task_key: row.task_key,
    started_at: row.started_at,
    match: directlyLinked ? 'direct task link' : 'literal text match (weak relevance)',
    snippet: searchSnippet(row.text, query, directlyLinked),
    ...(includeFull ? { content: row.text } : {}),
  }
}

function rulingCandidates(d: Database): Record<string, unknown>[] {
  return d
    .query(
      `SELECT q.number,turn.number AS run_number,turn.record_id AS run_record_id,
          root.number AS root_run_number,root.record_id AS root_run_record_id,
          root.launch_key AS task_key,turn.started_at,q.question,q.options,
          q.recommendation,q.why,q.answer
       FROM question q
       JOIN run turn ON turn.record_id=q.run_record_id
       JOIN run root ON root.record_id=COALESCE(turn.parent_run_record_id,turn.record_id)
      WHERE q.answer IS NOT NULL`,
    )
    .all()
    .map((row) => {
      const { number, ...rest } = row as Record<string, unknown> & { number: number }
      return { id: number, ...rest }
    })
}

function scoreCandidates(d: Database): Record<string, unknown>[] {
  return d
    .query(
      `SELECT s.number AS id, r.number AS run_number, r.record_id AS run_record_id,
          root.number AS root_run_number, root.record_id AS root_run_record_id,
          root.launch_key AS task_key, r.started_at, s.note
       FROM score s JOIN run r ON r.record_id=s.run_record_id
       JOIN run root ON root.record_id=COALESCE(r.parent_run_record_id,r.record_id)
      WHERE s.note IS NOT NULL AND trim(s.note) <> ''`,
    )
    .all() as Record<string, unknown>[]
}

/** A compact excerpt around the first literal match. Never returns the whole record by default. */
export function searchSnippet(text: string, query: string, directlyLinked: boolean): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const at = directlyLinked ? -1 : clean.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  const center = at < 0 ? 0 : at
  const start = Math.max(0, Math.min(center - 80, clean.length - SNIPPET_LENGTH))
  const excerpt = clean.slice(start, start + SNIPPET_LENGTH)
  return `${start > 0 ? '…' : ''}${excerpt}${start + SNIPPET_LENGTH < clean.length ? '…' : ''}`
}

/**
 * Search the consultation record without adding a second index that can drift from it.
 *
 * Task-key matches are direct links already recorded on the run. Every other result is
 * only a literal text match: useful evidence that the record mentions the query, but
 * deliberately not a claim that the result is relevant.
 */
export function searchRecords(
  d: Database,
  rawQuery: string,
  limit = 20,
  includeFull = false,
): RecordSearch {
  const query = rawQuery.trim()
  if (!query) throw new Error('search query must not be empty')
  if (!Number.isInteger(limit) || limit < 1)
    throw new Error('search limit must be a positive integer')

  const rows: Candidate[] = []
  const add = (
    source: RecordSource,
    records: Record<string, unknown>[],
    text: (row: Record<string, unknown>) => string,
  ) => {
    for (const row of records) {
      rows.push({
        source,
        id: row.id as number | string,
        run_number: Number(row.run_number),
        run_record_id: String(row.run_record_id),
        root_run_number: Number(row.root_run_number),
        root_run_record_id: String(row.root_run_record_id),
        task_key: row.task_key as string | null,
        started_at: String(row.started_at),
        text: text(row),
      })
    }
  }

  add('score', scoreCandidates(d), (row) => String(row.note))

  add('ruling', rulingCandidates(d), (row) =>
    [row.question, row.options, row.recommendation, row.why, row.answer]
      .filter((value) => value !== null)
      .join('\n'),
  )

  add(
    'review',
    d
      .query(
        `SELECT review.number || '/' || rf.ordinal AS id,
            r.number AS run_number, r.record_id AS run_record_id,
            root.number AS root_run_number,
            root.record_id AS root_run_record_id,
            root.launch_key AS task_key, r.started_at,
            rf.severity, rf.location, rf.evidence, rf.proposed_correction,
            rf.disposition, rf.rejection_category
       FROM review_finding rf
       JOIN review_lens rl ON rl.record_id=rf.review_lens_record_id
       JOIN review ON review.record_id=rf.review_record_id
       JOIN run r ON r.record_id=rl.run_record_id
       JOIN run root ON root.record_id=COALESCE(r.parent_run_record_id, r.record_id)`,
      )
      .all() as Record<string, unknown>[],
    (row) =>
      [
        row.severity,
        row.location,
        row.evidence,
        row.proposed_correction,
        row.disposition,
        row.rejection_category,
      ]
        .filter((value) => value !== null)
        .join('\n'),
  )

  let unavailableOutputs = 0
  const outputRows = d
    .query(
      `SELECT r.number AS run_number, r.record_id AS run_record_id,
            root.number AS root_run_number,
            root.record_id AS root_run_record_id,
            root.launch_key AS task_key, r.started_at, r.output_path
       FROM run r JOIN run root ON root.record_id=COALESCE(r.parent_run_record_id, r.record_id)
      WHERE r.output_path IS NOT NULL`,
    )
    .all() as Record<string, unknown>[]
  for (const row of outputRows) {
    const path = String(row.output_path)
    if (!existsSync(path)) {
      unavailableOutputs++
      continue
    }
    try {
      add('output', [{ ...row, id: row.run_number }], () => readFileSync(path, 'utf8'))
    } catch {
      unavailableOutputs++
    }
  }

  const folded = query.toLocaleLowerCase()
  const matches = rows
    .flatMap((row) => {
      const directlyLinked = row.task_key?.toLocaleLowerCase() === folded
      if (!directlyLinked && !row.text.toLocaleLowerCase().includes(folded)) return []
      return [matchedResult(row, query, includeFull)]
    })
    .sort((a, b) => {
      if (a.match !== b.match) return a.match === 'direct task link' ? -1 : 1
      return b.started_at.localeCompare(a.started_at) || b.run_number - a.run_number
    })

  return {
    query,
    results: matches.slice(0, limit),
    unavailable_outputs: unavailableOutputs,
    truncated: matches.length > limit,
  }
}
