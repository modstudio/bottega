// concern: ruling-overturn
/** Records withdrawal of an answered question. Must not know CLI grammar or dispatch. */

import { db, nowIso, sessionId, writableDb, writeTransaction } from '../database/db.ts'
import { auditQuestionMutation, authorizeWorkflowQuestionMutation } from './question-mutation.ts'
import { enqueueQuestionRecord } from './question-outbox.ts'
import { rulingActor } from './question-vocabulary.ts'
import { overturnRulingDecision } from './ruling-overturn-authority.ts'
import { adoptRunMutation, auditRunMutation, runMutationActor } from './run-authority.ts'

type OverturnRow = {
  id: number
  run_id: number | null
  root_id: number | null
  workflow_cursor_id: number | null
  workflow_owner: string | null
  workflow_updated_at: string | null
  answered_at: string | null
  overturned_at: string | null
  overturned_by: string | null
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
    return `question ${row.id} is unanswered and has no ruling to overturn; record its ruling first`
  }
  if (decision.code === 'already-overturned') {
    return (
      `question ${row.id} was already overturned at ${row.overturned_at} by ${row.overturned_by}` +
      `${row.overturn_reason ? ` because ${row.overturn_reason}` : ''}; ` +
      `review the existing overturn before attempting to overturn it again`
    )
  }
  return null
}

export function overturnRuling(input: {
  questionId: number
  reason: string
  replacement: string | null
  fromOperator: boolean
}) {
  writableDb()
  const row = db()
    .query(
      `SELECT q.id,q.run_id,COALESCE(owner.parent_run_id,owner.id) root_id,
              q.workflow_cursor_id,c.session_id workflow_owner,c.updated_at workflow_updated_at,
              q.answered_at,q.overturned_at,q.overturned_by,q.overturn_reason,q.replacement
         FROM question q LEFT JOIN run owner ON owner.id=q.run_id
         LEFT JOIN workflow_cursor c ON c.id=q.workflow_cursor_id WHERE q.id=?`,
    )
    .get(input.questionId) as OverturnRow | null
  if (!row)
    throw new Error(`no question ${input.questionId}; inspect question ids with orch inbox --all`)
  let authority = row.run_id === null ? null : runMutationActor(row.run_id)
  const actor = sessionId()
  const denied = refusal(row)
  if (denied) throw new Error(denied)
  let adoptionReason: string | null = null
  if (row.run_id === null)
    adoptionReason = authorizeWorkflowQuestionMutation({
      owner: row.workflow_owner,
      actor,
      fromOperator: input.fromOperator,
      subject: `workflow cursor ${row.workflow_cursor_id}`,
      action: 'overturn',
      chainLastActivityAt: Date.parse(row.workflow_updated_at!),
    })
  const at = nowIso()
  let overturnedBy = ''
  writeTransaction(() => {
    if (row.run_id !== null) authority = adoptRunMutation(authority!, 'overturn')
    overturnedBy = rulingActor(input.fromOperator, actor)
    const changed = db()
      .query(
        `UPDATE question
            SET overturned_at=?,overturned_by=?,overturn_reason=?,replacement=?,revision=revision+1
          WHERE id=? AND answered_at IS NOT NULL AND overturned_at IS NULL`,
      )
      .run(at, overturnedBy, input.reason, input.replacement, row.id)
    if (changed.changes !== 1)
      throw new Error(`question ${row.id} changed before it was overturned`)
    if (row.run_id !== null) auditRunMutation(authority!, 'overturn', input.reason)
    else
      auditQuestionMutation({
        questionId: row.id,
        action: 'overturn',
        actor,
        at,
        reason: input.reason,
        adoptionReason,
      })
    enqueueQuestionRecord(db(), row.id)
  })
  return {
    question_id: row.id,
    ruling_status: 'overturned',
    overturned_at: at,
    overturned_by: overturnedBy,
    overturn_reason: input.reason,
    replacement: input.replacement,
  }
}
