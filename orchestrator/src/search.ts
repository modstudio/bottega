import type { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'

export type RecordSource = 'score' | 'ruling' | 'review' | 'output'

export type RecordSearchResult = {
  source: RecordSource
  record_id: number
  run_id: number
  root_run_id: number
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

/** A compact excerpt around the first literal match. Never returns the whole record by default. */
export function searchSnippet(text: string, query: string, directlyLinked: boolean): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const at = directlyLinked ? -1 : clean.toLocaleLowerCase().indexOf(query.toLocaleLowerCase())
  const centre = at < 0 ? 0 : at
  const start = Math.max(0, Math.min(centre - 80, clean.length - SNIPPET_LENGTH))
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
        record_id: Number(row.record_id),
        run_id: Number(row.run_id),
        root_run_id: Number(row.root_run_id),
        task_key: row.task_key as string | null,
        started_at: String(row.started_at),
        text: text(row),
      })
    }
  }

  add(
    'score',
    d
      .query(
        `SELECT s.id AS record_id, s.run_id, r.id AS root_run_id,
            r.launch_key AS task_key, r.started_at, s.note
       FROM score s JOIN run r ON r.id=s.run_id
      WHERE s.note IS NOT NULL AND trim(s.note) <> ''`,
      )
      .all() as Record<string, unknown>[],
    (row) => String(row.note),
  )

  add(
    'ruling',
    d
      .query(
        `SELECT q.id AS record_id, q.run_id,
            COALESCE(turn.parent_run_id, turn.id) AS root_run_id,
            root.launch_key AS task_key, turn.started_at, q.question, q.options,
            q.recommendation, q.why, q.answer
       FROM question q
       JOIN run turn ON turn.id=q.run_id
       JOIN run root ON root.id=COALESCE(turn.parent_run_id, turn.id)
      WHERE q.answer IS NOT NULL`,
      )
      .all() as Record<string, unknown>[],
    (row) =>
      [row.question, row.options, row.recommendation, row.why, row.answer]
        .filter((value) => value !== null)
        .join('\n'),
  )

  add(
    'review',
    d
      .query(
        `SELECT rf.id AS record_id, rl.run_id,
            COALESCE(r.parent_run_id, r.id) AS root_run_id,
            root.launch_key AS task_key, r.started_at,
            rf.severity, rf.location, rf.evidence, rf.proposed_correction,
            rf.disposition, rf.rejection_category
       FROM review_finding rf
       JOIN review_lens rl ON rl.id=rf.review_lens_id
       JOIN run r ON r.id=rl.run_id
       JOIN run root ON root.id=COALESCE(r.parent_run_id, r.id)`,
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
      `SELECT r.id AS run_id, COALESCE(r.parent_run_id, r.id) AS root_run_id,
            root.launch_key AS task_key, r.started_at, r.output_path
       FROM run r JOIN run root ON root.id=COALESCE(r.parent_run_id, r.id)
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
      add('output', [{ ...row, record_id: row.run_id }], () => readFileSync(path, 'utf8'))
    } catch {
      unavailableOutputs++
    }
  }

  const folded = query.toLocaleLowerCase()
  const matches = rows
    .flatMap((row) => {
      const directlyLinked = row.task_key?.toLocaleLowerCase() === folded
      if (!directlyLinked && !row.text.toLocaleLowerCase().includes(folded)) return []
      return [
        {
          source: row.source,
          record_id: row.record_id,
          run_id: row.run_id,
          root_run_id: row.root_run_id,
          task_key: row.task_key,
          started_at: row.started_at,
          match: directlyLinked
            ? ('direct task link' as const)
            : ('literal text match (weak relevance)' as const),
          snippet: searchSnippet(row.text, query, directlyLinked),
          ...(includeFull ? { content: row.text } : {}),
        },
      ]
    })
    .sort((a, b) => {
      if (a.match !== b.match) return a.match === 'direct task link' ? -1 : 1
      return b.started_at.localeCompare(a.started_at) || b.run_id - a.run_id
    })

  return {
    query,
    results: matches.slice(0, limit),
    unavailable_outputs: unavailableOutputs,
    truncated: matches.length > limit,
  }
}
