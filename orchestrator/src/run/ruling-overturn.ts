// concern: ruling-overturn
/** Records withdrawal of an answered question. Must not know CLI grammar or dispatch. */

import { db, nowIso, writableDb, writeTransaction } from '../database/db.ts'
import { rulingActor } from './question-vocabulary.ts'
import { overturnRulingDecision } from './ruling-overturn-authority.ts'
import {
  adoptRunMutation,
  auditRunMutation,
  type RootAuthority,
  runMutationActor,
} from './run-authority.ts'

type OverturnRow = {
  id: number
  run_id: number
  root_id: number
  answered_at: string | null
  overturned_at: string | null
  overturned_by: string | null
  overturn_reason: string | null
  replacement: string | null
}

function refusal(row: OverturnRow, authority: RootAuthority): string | null {
  const decision = overturnRulingDecision({
    answeredAt: row.answered_at,
    overturnedAt: row.overturned_at,
    owner: authority.owner,
    actor: authority.actor,
  })
  if (decision.kind === 'allow') return null
  if (decision.code === 'unanswered') {
    return (
      `question ${row.id} is unanswered and has no ruling to overturn; ` +
      `answer its chain first with orch answer ${row.root_id} "<ruling>"`
    )
  }
  if (decision.code === 'already-overturned') {
    return (
      `question ${row.id} was already overturned at ${row.overturned_at} by ${row.overturned_by}` +
      `${row.overturn_reason ? ` because ${row.overturn_reason}` : ''}; ` +
      `review the existing overturn before attempting to overturn it again`
    )
  }
  return (
    `run ${row.root_id} is owned by session ${authority.owner}; ` +
    `current session ${authority.actor ?? 'no session identity is present'} cannot overturn its ruling`
  )
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
              q.answered_at,q.overturned_at,q.overturned_by,q.overturn_reason,q.replacement
         FROM question q JOIN run owner ON owner.id=q.run_id WHERE q.id=?`,
    )
    .get(input.questionId) as OverturnRow | null
  if (!row)
    throw new Error(`no question ${input.questionId}; inspect question ids with orch inbox --all`)
  let authority = runMutationActor(row.run_id)
  const denied = refusal(row, authority)
  if (denied) throw new Error(denied)
  const at = nowIso()
  let overturnedBy = ''
  writeTransaction(() => {
    authority = adoptRunMutation(authority, 'overturn')
    overturnedBy = rulingActor(input.fromOperator, authority.actor)
    const changed = db()
      .query(
        `UPDATE question
            SET overturned_at=?,overturned_by=?,overturn_reason=?,replacement=?
          WHERE id=? AND answered_at IS NOT NULL AND overturned_at IS NULL`,
      )
      .run(at, overturnedBy, input.reason, input.replacement, row.id)
    if (changed.changes !== 1)
      throw new Error(`question ${row.id} changed before it was overturned`)
    auditRunMutation(authority, 'overturn', input.reason)
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
