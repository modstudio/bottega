// concern: question-vocabulary
/** Knows question provenance and delivery vocabularies, but no database state or adapters. */

import {
  ANSWERER_KIND_AGENT,
  ANSWERER_KIND_EVAL,
  ANSWERER_KIND_OPERATOR,
  type AnswererKind,
} from '../../../shared/question-vocabulary.ts'

export * from '../../../shared/question-vocabulary.ts'

export function rulingActor(fromOperator: boolean, session: string | null): string {
  return fromOperator
    ? `operator via ${session ?? 'anonymous (no session id)'}`
    : (session ?? 'anonymous (no session id)')
}

export function rulingStatus(
  overturnedAt: unknown,
  answeredAt: unknown,
): 'overturned' | 'answered' | 'open' {
  return overturnedAt ? 'overturned' : answeredAt ? 'answered' : 'open'
}

export function answererKindFromAnsweredBy(answeredBy: string | null): AnswererKind | null {
  if (answeredBy === null) return null
  if (answeredBy.startsWith('operator via ')) return ANSWERER_KIND_OPERATOR
  if (answeredBy === 'canon-eval') return ANSWERER_KIND_EVAL
  return ANSWERER_KIND_AGENT
}
