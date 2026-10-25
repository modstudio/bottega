// concern: ruling-list
/** Reads ruling history for adapters. Must not know CLI grammar or printing. */

import { type RulingListRow, RulingListSchema } from '../../../shared/orch-contract.ts'
import { db } from '../database/db.ts'
import { questionOpenSql } from './question-open.ts'

export function listRulings(options: {
  since?: string
  kind: 'workflow' | 'run' | 'all'
}): RulingListRow[] {
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
  const rows = db()
    .query(
      `SELECT q.number,q.record_id,q.run_record_id,r.number AS run_number,
              q.workflow_cursor_record_id workflow_cursor_id,q.workflow_key,
              COALESCE(r.repo,c.project) project,c.workflow_slug,c.mode_slug,
              COALESCE(r.session_id,c.session_id) session_id,
              q.asked_at,q.question,q.answer,q.answer_basis,q.answered_at,
              COALESCE(q.answered_by_name,q.answered_by) answered_by,q.asked_via,
              q.answerer_kind,q.answer_channel,q.closed_at,q.close_reason,
              q.overturned_at,COALESCE(q.overturned_by_name,q.overturned_by) overturned_by,q.overturn_reason,q.replacement,
              q.filed_as,q.filed_ref,q.filed_record_id,q.filed_label,q.filed_at
         FROM question q LEFT JOIN run r ON r.record_id=q.run_record_id
         LEFT JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id
        ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY q.number`,
    )
    .all(...values)
  return RulingListSchema.parse(
    (rows as Array<Record<string, unknown> & { number: number }>).map(({ number, ...row }) => ({
      id: number,
      ...row,
    })),
  )
}
