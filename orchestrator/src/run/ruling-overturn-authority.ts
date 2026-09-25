// concern: ruling-overturn
/** Decides overturn refusals and authority without touching process or database state. */

import { runMutationOwnerDecision } from './run-mutation-owner.ts'

export type OverturnRulingDecision =
  | { kind: 'allow' }
  | { kind: 'refuse'; code: 'unanswered' | 'already-overturned' | 'owner-mismatch' }

export function overturnRulingDecision(input: {
  answeredAt: string | null
  overturnedAt: string | null
  owner: string | null
  actor: string | null
}): OverturnRulingDecision {
  if (input.answeredAt === null) return { kind: 'refuse', code: 'unanswered' }
  if (input.overturnedAt !== null) return { kind: 'refuse', code: 'already-overturned' }
  const owner = runMutationOwnerDecision({ owner: input.owner, actor: input.actor })
  if (owner.kind === 'refuse') return owner
  return { kind: 'allow' }
}
