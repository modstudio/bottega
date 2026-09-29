import type { AnswerChannel } from '../../../shared/question-vocabulary.ts'
import { type RunMutationOwnerFacts, runMutationOwnerDecision } from './run-mutation-owner.ts'

export type AnswerAuthorityDecision =
  | { kind: 'allow-as-owner' }
  | { kind: 'allow-as-operator'; actor: 'operator:ui' }
  | {
      kind: 'refuse'
      code: 'operator-attribution' | 'dashboard-capability' | 'session-marker' | 'owner-mismatch'
      owner?: string
      actor?: string
    }

/** Decide answer authority without touching process state or the database. */
export function answerAuthorityDecision(
  input: RunMutationOwnerFacts & {
    channel: AnswerChannel
    fromOperator: boolean
    sessionIdPresent: boolean
    depthPresent: boolean
    dashboardAuthorized: boolean
  },
): AnswerAuthorityDecision {
  if (input.channel === 'ui') {
    if (!input.fromOperator) return { kind: 'refuse', code: 'operator-attribution' }
    if (input.sessionIdPresent)
      return { kind: 'refuse', code: 'session-marker', actor: 'CLAUDE_CODE_SESSION_ID' }
    if (input.depthPresent) return { kind: 'refuse', code: 'session-marker', actor: 'ORCH_DEPTH' }
    if (!input.dashboardAuthorized) return { kind: 'refuse', code: 'dashboard-capability' }
    return { kind: 'allow-as-operator', actor: 'operator:ui' }
  }
  const owner = runMutationOwnerDecision(input)
  if (owner === 'refuse') {
    return {
      kind: 'refuse',
      code: 'owner-mismatch',
      owner: input.owner ?? undefined,
      actor: input.actor ?? undefined,
    }
  }
  return { kind: 'allow-as-owner' }
}
