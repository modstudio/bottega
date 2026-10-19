// concern: question-mutation
/** Owns authority and audit for workflow-question mutations. Run questions keep run authority. */

import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { callerIdentityRefusal } from '../caller-classification.ts'
import { callerIdentity, db } from '../database/db.ts'
import { nextQuestionNumber } from './question-number.ts'
import { questionOpenSql } from './question-open.ts'
import { enqueueQuestionRecord } from './question-outbox.ts'
import { rulingActor } from './question-vocabulary.ts'
import {
  joinMutationReason,
  RUN_MUTATION_WINDOW_MS,
  type RunMutationOwnerFacts,
  reauthorizeAdoptedMutation,
  runMutationOwnerDecision,
} from './run-mutation-owner.ts'

export type QuestionMutationAction = 'rule' | 'overturn' | 'file' | 'close'

export function authorizeWorkflowQuestionMutation(input: {
  owner: string | null
  actor: string | null
  fromOperator: boolean
  subject: string
  action: QuestionMutationAction
  chainLastActivityAt: number
  now?: number
  database?: Database
}): string | null {
  const database = input.database ?? db()
  const readFacts = (): RunMutationOwnerFacts => {
    const seen =
      input.owner === null
        ? null
        : (database
            .query('SELECT last_seen FROM session_seen WHERE session_id=?')
            .get(input.owner) as { last_seen: string } | null)
    return {
      owner: input.owner,
      actor: input.actor,
      ownerLastSeenAt: seen ? Date.parse(seen.last_seen) : null,
      chainLastActivityAt: input.chainLastActivityAt,
      now: input.now ?? Date.now(),
      windowMs: RUN_MUTATION_WINDOW_MS,
    }
  }
  const initial = readFacts()
  const refusal = () => {
    if (!input.actor)
      throw new Error(
        `${input.subject} is owned by session ${input.owner}; ${callerIdentityRefusal(callerIdentity(), input.action)}`,
      )
    throw new Error(
      `${input.subject} is owned by session ${input.owner}; ` +
        `current session ${input.actor} cannot ${input.action} it (owner active within the window)`,
    )
  }
  const current = reauthorizeAdoptedMutation(initial, readFacts, refusal)
  const decision = runMutationOwnerDecision(current)
  if (input.fromOperator || decision === 'owner') return null
  if (decision === 'adopt') return `adopted from gone owner ${input.owner} by ${input.actor}`
  return refusal()
}

export function auditQuestionMutation(
  input: {
    questionId: string
    action: QuestionMutationAction
    actor: string | null
    at: string
    reason: string | null
    adoptionReason?: string | null
  },
  database: Database = db(),
): void {
  database
    .query(
      `INSERT INTO question_mutation_audit (record_id,question_record_id,action,actor_session,at,reason)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(
      newRecordId(),
      input.questionId,
      input.action,
      input.actor,
      input.at,
      joinMutationReason(input.reason, input.adoptionReason ?? null),
    )
}

export function upsertWorkflowQuestion(
  input: {
    cursorId: number
    workflowKey: string
    stepOrdinal: number
    stepSlug: string
    question: string
    at: string
  },
  database: Database = db(),
): { recordId: string; number: number } {
  const open = database
    .query<{ record_id: string; number: number }, [number]>(
      `SELECT record_id,number FROM question
       WHERE workflow_cursor_id=? AND ${questionOpenSql('question')}`,
    )
    .get(input.cursorId)
  if (open) {
    database
      .query(
        `UPDATE question SET question=?,workflow_key=?,workflow_step_ordinal=?,workflow_step_slug=?,
         revision=revision+1 WHERE record_id=?`,
      )
      .run(
        input.question,
        input.workflowKey || null,
        input.stepOrdinal,
        input.stepSlug,
        open.record_id,
      )
    enqueueQuestionRecord(database, open.record_id)
    return { recordId: open.record_id, number: open.number }
  }
  const recordId = newRecordId()
  const inserted = database
    .query<{ record_id: string; number: number }, (string | number | null)[]>(
      `INSERT INTO question
        (record_id,number,workflow_cursor_id,workflow_key,asked_at,question,asked_via,awaiting_operator_at,
         workflow_step_ordinal,workflow_step_slug)
       VALUES (?,?,?,?,?,?, 'workflow', ?,?,?) RETURNING record_id,number`,
    )
    .get(
      recordId,
      nextQuestionNumber(database),
      input.cursorId,
      input.workflowKey || null,
      input.at,
      input.question,
      input.at,
      input.stepOrdinal,
      input.stepSlug,
    )
  if (!inserted) throw new Error('workflow question was not recorded')
  enqueueQuestionRecord(database, inserted.record_id)
  return { recordId: inserted.record_id, number: inserted.number }
}

export function answerWorkflowQuestion(
  input: {
    questionId: string
    cursorId: number
    ruling: string
    basis?: string | null
    at: string
    actor: string | null
    fromOperator: boolean
    channel: 'cli' | 'mcp'
    adoptionReason?: string | null
  },
  database: Database = db(),
): void {
  const changed = database
    .query(
      `UPDATE question SET answer=?,answer_basis=?,answered_at=?,answered_by=?,answerer_kind=?,answer_channel=?,
        revision=revision+1
       WHERE record_id=? AND workflow_cursor_id=? AND ${questionOpenSql('question')}`,
    )
    .run(
      input.ruling,
      input.basis ?? null,
      input.at,
      rulingActor(input.fromOperator, input.actor),
      input.fromOperator ? 'operator' : 'agent',
      input.channel,
      input.questionId,
      input.cursorId,
    )
  if (changed.changes !== 1) throw new Error(`question ${input.questionId} is not open`)
  auditQuestionMutation(
    {
      questionId: input.questionId,
      action: 'rule',
      actor: input.actor,
      at: input.at,
      reason: input.ruling,
      adoptionReason: input.adoptionReason,
    },
    database,
  )
  enqueueQuestionRecord(database, input.questionId)
}
