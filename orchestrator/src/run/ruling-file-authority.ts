// concern: ruling-file
/** Decides whether a ruling may be filed, without touching process or database state. */

import type { AnswerChannel } from '../../../shared/question-vocabulary.ts'
import { answerAuthorityDecision } from './run-answer-authority.ts'
import type { RunMutationOwnerFacts } from './run-mutation-owner.ts'

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
        | 'owner-scope'
      owner?: string
      actor?: string
      scope?: string
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
}): 'owner-scope' | 'foreign-project' | null {
  if (input.operator || input.requested !== 'doc') return null
  const subject = input.subject ?? (input.scope === 'project' ? input.runProject : undefined)
  if (input.scope === 'project' && subject === input.runProject) return null
  if (subject !== undefined && subject !== input.runProject) return 'foreign-project'
  // scope 'settings' never reaches here: the edge validator refuses it for everyone before ownership is consulted.
  return 'owner-scope'
}

export function fileRulingDecision(
  input: RunMutationOwnerFacts & {
    answeredAt: string | null
    overturnedAt: string | null
    replacement: string | null
    filedAs: string | null
    requested: FiledRulingKind
    scope?: string
    fromOperator: boolean
    channel: AnswerChannel
    sessionIdPresent: boolean
    depthPresent: boolean
    dashboardAuthorized: boolean
    runProject: string | null
    subject?: string
    workflowAuthority?: { operator: boolean }
  },
): FileRulingDecision {
  if (input.answeredAt === null) return { kind: 'refuse', code: 'unanswered' }
  if (input.overturnedAt !== null && !input.replacement) {
    return { kind: 'refuse', code: 'overturned-without-replacement' }
  }
  if (input.filedAs !== null) return { kind: 'refuse', code: 'already-filed' }
  const scope = input.scope ?? 'project'
  if (decideCanonFiling(input.requested, scope)) {
    return { kind: 'refuse', code: 'canon-direct' }
  }
  const authority =
    input.workflowAuthority && input.channel !== 'ui'
      ? input.workflowAuthority.operator
        ? ({ kind: 'allow-as-operator', actor: 'operator:ui' } as const)
        : ({ kind: 'allow-as-owner' } as const)
      : answerAuthorityDecision({
          channel: input.channel,
          fromOperator: input.fromOperator,
          sessionIdPresent: input.sessionIdPresent,
          depthPresent: input.depthPresent,
          dashboardAuthorized: input.dashboardAuthorized,
          owner: input.owner,
          actor: input.actor,
          ownerLastSeenAt: input.ownerLastSeenAt,
          chainLastActivityAt: input.chainLastActivityAt,
          coordinatorRun: input.coordinatorRun,
          now: input.now,
          windowMs: input.windowMs,
          ownerProcess: input.ownerProcess,
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
    scope,
    subject: input.subject,
    runProject: input.runProject,
  })
  if (foreign) return { kind: 'refuse', code: foreign, scope }
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
