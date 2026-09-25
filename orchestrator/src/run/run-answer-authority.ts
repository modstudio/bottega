import type { AnswerChannel } from '../../../shared/question-vocabulary.ts'

export type AnswerAuthorityDecision =
  | { kind: 'allow-as-owner' }
  | { kind: 'allow-as-operator'; actor: 'operator:ui' }
  | { kind: 'refuse'; reason: string }

/** Decide answer authority without touching process state or the database. */
export function answerAuthorityDecision(input: {
  channel: AnswerChannel
  fromOperator: boolean
  sessionIdPresent: boolean
  depthPresent: boolean
  owner: string | null
  actor: string | null
}): AnswerAuthorityDecision {
  if (input.channel === 'ui') {
    if (!input.fromOperator)
      return { kind: 'refuse', reason: '--channel ui requires --from-operator' }
    if (input.sessionIdPresent)
      return {
        kind: 'refuse',
        reason: '--channel ui is refused when CLAUDE_CODE_SESSION_ID is set',
      }
    if (input.depthPresent)
      return { kind: 'refuse', reason: '--channel ui is refused when ORCH_DEPTH is set' }
    return { kind: 'allow-as-operator', actor: 'operator:ui' }
  }
  if (input.owner && input.actor !== input.owner) {
    return {
      kind: 'refuse',
      reason:
        `run is owned by session ${input.owner}; ` +
        `current session ${input.actor ?? 'no session identity is present'} cannot answer it`,
    }
  }
  return { kind: 'allow-as-owner' }
}
