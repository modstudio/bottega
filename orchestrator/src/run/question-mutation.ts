// concern: question-mutation
/** Owns authority and audit for workflow-question mutations. Run questions keep run authority. */

import type { Database } from 'bun:sqlite'
import { db } from '../database/db.ts'
import { runMutationOwnerDecision } from './run-mutation-owner.ts'

export type QuestionMutationAction = 'rule' | 'overturn' | 'file' | 'close'

export function authorizeWorkflowQuestionMutation(input: {
  owner: string | null
  actor: string | null
  fromOperator: boolean
  subject: string
  action: QuestionMutationAction
}): void {
  const decision = runMutationOwnerDecision({ owner: input.owner, actor: input.actor })
  if (decision.kind === 'allow' || input.fromOperator) return
  throw new Error(
    `${input.subject} is owned by session ${input.owner}; ` +
      `current session ${input.actor ?? 'no session identity is present'} cannot ${input.action} it`,
  )
}

export function auditQuestionMutation(
  input: {
    questionId: number
    action: QuestionMutationAction
    actor: string | null
    at: string
    reason: string | null
  },
  database: Database = db(),
): void {
  database
    .query(
      `INSERT INTO question_mutation_audit (question_id,action,actor_session,at,reason)
       VALUES (?,?,?,?,?)`,
    )
    .run(input.questionId, input.action, input.actor, input.at, input.reason)
}
