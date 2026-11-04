// concern: ruling-list
/** Reads ruling history for adapters. Must not know CLI grammar or printing. */

import { type RulingListRow, RulingListSchema } from '../../../shared/orch-contract.ts'
import { db } from '../database/db.ts'
import { changedAfter, collectChangeCursor } from './collect-change.ts'
import { questionOpenSql } from './question-open.ts'

type RulingListOptions = {
  since?: string
  changedAfter?: string
  kind: 'workflow' | 'run' | 'all'
}

export function listRulings(options: RulingListOptions): RulingListRow[] {
  return queryRulings(options).rows
}

/** The rows changed after the cursor, with the snapshot the query was bounded by. */
export function listRulingChanges(options: RulingListOptions & { changedAfter: string }): {
  cursor: number
  rows: RulingListRow[]
} {
  const result = queryRulings(options)
  if (result.cursor === null) throw new Error('unreachable: a changed-after query has a cursor')
  return { cursor: result.cursor, rows: result.rows }
}

function queryRulings(options: RulingListOptions): {
  cursor: number | null
  rows: RulingListRow[]
} {
  const clauses: string[] = []
  const values: string[] = []
  if (options.kind === 'workflow') clauses.push('q.workflow_cursor_record_id IS NOT NULL')
  else if (options.kind === 'run') clauses.push('q.run_record_id IS NOT NULL')
  if (options.since) {
    if (!Number.isFinite(Date.parse(options.since))) throw new Error('--since must be an ISO date')
    clauses.push(
      `(${questionOpenSql('q')} OR q.asked_at>=? OR q.answered_at>=? OR q.closed_at>=? OR q.overturned_at>=? OR q.filed_at>=?)`,
    )
    values.push(options.since, options.since, options.since, options.since, options.since)
  }
  const after = changedAfter(options.changedAfter)
  const cursor = after === null ? null : collectChangeCursor()
  if (options.since && after !== null)
    throw new Error('--since and --changed-after cannot be combined')
  if (after !== null) {
    clauses.push('q.change_seq>? AND q.change_seq<=?')
    values.push(String(after), String(cursor))
  }
  const rows = db()
    .query(
      `SELECT q.number,q.record_id,q.run_record_id,r.number AS run_number,
              q.workflow_cursor_record_id workflow_cursor_id,q.workflow_key,
              COALESCE(r.repo,c.project) project,c.workflow_slug,c.mode_slug,
              COALESCE(r.session_id,c.session_id) session_id,
              q.asked_at,q.question,q.answer,q.answer_basis,q.answered_at,
              q.answered_by,q.answered_by_name,q.asked_via,
              q.answerer_kind,q.answer_channel,q.closed_at,q.close_reason,
              q.overturned_at,q.overturned_by,q.overturned_by_name,q.overturn_reason,q.replacement,
              q.filed_as,q.filed_ref,q.filed_record_id,q.filed_label,q.filed_at
         FROM question q LEFT JOIN run r ON r.record_id=q.run_record_id
         LEFT JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY q.number`,
    )
    .all(...values)
  const parsed = RulingListSchema.parse(
    (rows as Array<Record<string, unknown> & { number: number }>).map(({ number, ...row }) => ({
      id: number,
      ...row,
    })),
  )
  return { cursor, rows: parsed }
}
