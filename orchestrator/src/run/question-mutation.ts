// concern: question-mutation
/** Owns authority and audit for workflow-question mutations. Run questions keep run authority. */

import type { Database } from 'bun:sqlite'
import { callerIdentityRefusal } from '../caller-classification.ts'
import { callerIdentity, db } from '../database/db.ts'
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
    questionId: number
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
      `INSERT INTO question_mutation_audit (question_id,action,actor_session,at,reason)
       VALUES (?,?,?,?,?)`,
    )
    .run(
      input.questionId,
      input.action,
      input.actor,
      input.at,
      joinMutationReason(input.reason, input.adoptionReason ?? null),
    )
}
