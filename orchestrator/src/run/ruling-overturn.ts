// concern: ruling-overturn
/** Records withdrawal of an answered question. Must not know CLI grammar or dispatch. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import {
  auditQuestionMutation,
  authorizeWorkflowQuestionMutation,
  rulingPersonName,
} from './question-mutation.ts'
import { enqueueQuestionRecord } from './question-outbox.ts'
import { rulingActor } from './question-vocabulary.ts'
import { overturnRulingDecision } from './ruling-overturn-authority.ts'
import { adoptRunMutation, auditRunMutation, runMutationActor } from './run-authority.ts'

type OverturnRow = {
  record_id: string
  number: number
  run_record_id: string | null
  root_id: string | null
  workflow_cursor_record_id: string | null
  workflow_owner: string | null
  workflow_updated_at: string | null
  answered_at: string | null
  overturned_at: string | null
  overturned_by: string | null
  overturned_by_name: string | null
  overturn_reason: string | null
  replacement: string | null
}

function refusal(row: OverturnRow): string | null {
  const decision = overturnRulingDecision({
    answeredAt: row.answered_at,
    overturnedAt: row.overturned_at,
  })
  if (decision.kind === 'allow') return null
  if (decision.code === 'unanswered') {
    return `question ${row.number} is unanswered and has no ruling to overturn; record its ruling first`
  }
  if (decision.code === 'already-overturned') {
    return (
      `question ${row.number} was already overturned at ${row.overturned_at} by ${row.overturned_by_name ?? row.overturned_by}` +
      `${row.overturn_reason ? ` because ${row.overturn_reason}` : ''}; ` +
      `review the existing overturn before attempting to overturn it again`
    )
  }
  return null
}

export function overturnRuling(input: {
  questionId: string
  reason: string
  replacement: string | null
  fromOperator: boolean
}) {
  writableDb()
  const row = db()
    .query(
      `SELECT q.number,q.record_id,q.run_record_id,COALESCE(owner.parent_run_record_id,owner.record_id) root_id,
              q.workflow_cursor_record_id,c.session_id workflow_owner,c.updated_at workflow_updated_at,
              q.answered_at,q.overturned_at,q.overturned_by,q.overturned_by_name,q.overturn_reason,q.replacement
         FROM question q LEFT JOIN run owner ON owner.record_id=q.run_record_id
         LEFT JOIN workflow_cursor c ON c.record_id=q.workflow_cursor_record_id WHERE q.record_id=?`,
    )
    .get(input.questionId) as OverturnRow | null
  if (!row)
    throw new Error(
      `no question ${input.questionId}; inspect question ids with ${PLATFORM_SLUG} question inbox --all`,
    )
  let authority = row.run_record_id === null ? null : runMutationActor(row.run_record_id)
  const actor = sessionId()
  const denied = refusal(row)
  if (denied) throw new Error(denied)
  let adoptionReason: string | null = null
  if (row.run_record_id === null)
    adoptionReason = authorizeWorkflowQuestionMutation({
      owner: row.workflow_owner,
      actor,
      fromOperator: input.fromOperator,
      subject: `workflow cursor ${row.workflow_cursor_record_id}`,
      action: 'overturn',
      chainLastActivityAt: Date.parse(row.workflow_updated_at!),
    })
  const at = nowIso()
  const personName = rulingPersonName(input.fromOperator)
  let overturnedBy = ''
  writeTransaction(() => {
    if (row.run_record_id !== null) authority = adoptRunMutation(authority!, 'overturn')
    overturnedBy = rulingActor(input.fromOperator, actor)
    const changed = db()
      .query(
        `UPDATE question
            SET overturned_at=?,overturned_by=?,overturned_by_name=?,overturn_reason=?,replacement=?,revision=revision+1
          WHERE record_id=? AND answered_at IS NOT NULL AND overturned_at IS NULL`,
      )
      .run(at, overturnedBy, personName, input.reason, input.replacement, row.record_id)
    if (changed.changes !== 1)
      throw new Error(`question ${row.number} changed before it was overturned`)
    if (row.run_record_id !== null) auditRunMutation(authority!, 'overturn', input.reason)
    else
      auditQuestionMutation({
        questionId: row.record_id,
        action: 'overturn',
        actor,
        at,
        reason: input.reason,
        adoptionReason,
      })
    enqueueQuestionRecord(db(), row.record_id)
  })
  return {
    question_id: row.number,
    record_id: row.record_id,
    ruling_status: 'overturned',
    overturned_at: at,
    overturned_by: overturnedBy,
    overturn_reason: input.reason,
    replacement: input.replacement,
  }
}
