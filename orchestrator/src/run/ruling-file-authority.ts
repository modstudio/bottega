// concern: ruling-file
/** Decides whether a ruling may be filed, without touching process or database state. */

import type { AnswerChannel } from '../../../shared/question-vocabulary.ts'
import { answerAuthorityDecision } from './run-answer-authority.ts'

export type FiledRulingKind = 'doc' | 'canon-proposal'

export type FileRulingDecision =
  | { kind: 'allow'; operator: boolean }
  | {
      kind: 'refuse'
      code:
        | 'unanswered'
        | 'overturned-without-replacement'
        | 'already-filed'
        | 'canon-direct'
        | 'operator-attribution'
        | 'dashboard-capability'
        | 'session-marker'
        | 'owner-mismatch'
        | 'foreign-project'
      owner?: string
      actor?: string
    }

/** Refuse writing canon rows through --as doc; same shape as decideMcpDocWrite. */
export function decideCanonFiling(requested: FiledRulingKind, scope: string): string | null {
  if (requested !== 'doc' || scope !== 'canon') return null
  return 'canon is never written directly'
}

function ownerAddress(input: {
  operator: boolean
  requested: FiledRulingKind
  scope: string
  subject: string | undefined
  runProject: string | null
}): 'foreign-project' | null {
  if (input.operator || input.requested !== 'doc') return null
  const subject = input.subject ?? (input.scope === 'project' ? input.runProject : undefined)
  if (input.scope === 'project' && subject === input.runProject) return null
  return 'foreign-project'
}

export function fileRulingDecision(input: {
  answeredAt: string | null
  overturnedAt: string | null
  replacement: string | null
  filedAs: string | null
  requested: FiledRulingKind
  scope?: string
  owner: string | null
  actor: string | null
  fromOperator: boolean
  channel: AnswerChannel
  sessionIdPresent: boolean
  depthPresent: boolean
  dashboardAuthorized: boolean
  runProject: string | null
  subject?: string
}): FileRulingDecision {
  if (input.answeredAt === null) return { kind: 'refuse', code: 'unanswered' }
  if (input.overturnedAt !== null && !input.replacement) {
    return { kind: 'refuse', code: 'overturned-without-replacement' }
  }
  if (input.filedAs !== null) return { kind: 'refuse', code: 'already-filed' }
  if (decideCanonFiling(input.requested, input.scope ?? 'project')) {
    return { kind: 'refuse', code: 'canon-direct' }
  }
  const authority = answerAuthorityDecision({
    channel: input.channel,
    fromOperator: input.fromOperator,
    sessionIdPresent: input.sessionIdPresent,
    depthPresent: input.depthPresent,
    dashboardAuthorized: input.dashboardAuthorized,
    owner: input.owner,
    actor: input.actor,
  })
  if (authority.kind === 'refuse') {
    return {
      kind: 'refuse',
      code: authority.code,
      owner: authority.owner,
      actor: authority.actor,
    }
  }
  const operator = authority.kind === 'allow-as-operator' || input.fromOperator
  const foreign = ownerAddress({
    operator,
    requested: input.requested,
    scope: input.scope ?? 'project',
    subject: input.subject,
    runProject: input.runProject,
  })
  if (foreign) return { kind: 'refuse', code: foreign }
  return { kind: 'allow', operator }
}

export function effectiveRuling(input: {
  answer: string | null
  overturnedAt: string | null
  replacement: string | null
}): string | null {
  if (input.overturnedAt !== null) return input.replacement
  return input.answer
}
