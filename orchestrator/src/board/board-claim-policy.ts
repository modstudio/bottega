import { containsSecretShaped } from '../../../shared/secret-shaped.ts'
import { BOARD_BODY_MAX_CHARS } from './board-policy.ts'
import { pathTagRefusal } from './board-tags.ts'

export const BOARD_CLAIM_DEFAULT_MS = 4 * 60 * 60 * 1000
export const BOARD_CLAIM_MAX_MS = 24 * 60 * 60 * 1000
export const BOARD_CLAIM_RESOURCE_MAX_CHARS = 200

export type ClaimActor =
  | { kind: 'operator'; session: null }
  | { kind: 'architect'; session: string }
export type ClaimSubject = { kind: 'task' | 'path' | 'resource'; value: string }
export type ClaimCloseReason = 'released' | 'lapsed' | 'run-ended' | 'task-closed' | 'taken-over'
export type ClaimLiveness = {
  closed: boolean
  lapsesAt: number
  runStatus: string | null
  now: number
}

export function claimCloseReason(input: ClaimLiveness): ClaimCloseReason | null {
  if (input.closed) return null
  if (input.lapsesAt <= input.now) return 'lapsed'
  if (input.runStatus !== null && input.runStatus !== 'running' && input.runStatus !== 'asking')
    return 'run-ended'
  return null
}

export const claimIsLive = (input: ClaimLiveness): boolean =>
  !input.closed && claimCloseReason(input) === null

export function claimSubjectsConflict(left: ClaimSubject, right: ClaimSubject): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind !== 'path') return left.value === right.value
  return (
    left.value === right.value ||
    new Bun.Glob(left.value).match(right.value) ||
    new Bun.Glob(right.value).match(left.value)
  )
}

export type ClaimTakeDecision = 'take' | 'renew' | 'refuse' | 'take-over'
export function claimTakeDecision(input: {
  sameHolderSameSubject: boolean
  conflictingClaim: boolean
  foreignLiveConflict: boolean
  force: boolean
  actorKind: ClaimActor['kind']
}): ClaimTakeDecision {
  if (input.foreignLiveConflict)
    return input.force && input.actorKind === 'operator' ? 'take-over' : 'refuse'
  if (input.sameHolderSameSubject) return 'renew'
  return input.conflictingClaim ? 'take-over' : 'take'
}

export const sameClaimHolder = (actor: ClaimActor, holder: ClaimActor): boolean =>
  actor.kind === holder.kind && actor.session === holder.session

export const mayRenewClaim = (actor: ClaimActor, holder: ClaimActor): boolean =>
  sameClaimHolder(actor, holder)

export const mayReleaseClaim = (actor: ClaimActor, holder: ClaimActor): boolean =>
  actor.kind === 'operator' || sameClaimHolder(actor, holder)

export const mayForceClaim = (actor: ClaimActor): boolean => actor.kind === 'operator'

export function parseClaimSubject(expression: string): ClaimSubject {
  const match = /^(task|path|resource):(.*)$/.exec(expression)
  if (!match)
    throw new Error(
      `invalid claim subject ${expression}; use task:<KEY>, path:<glob>, or resource:<name>`,
    )
  const kind = match[1] as ClaimSubject['kind']
  const value = match[2]!.trim()
  if (!value) throw new Error(`claim ${kind} subject is empty; provide a value after ${kind}:`)
  if (kind === 'path') {
    const refusal = pathTagRefusal(value)
    if (refusal) throw new Error(refusal)
  }
  if (kind === 'resource') {
    if (value.length > BOARD_CLAIM_RESOURCE_MAX_CHARS)
      throw new Error(
        `claim resource exceeds ${BOARD_CLAIM_RESOURCE_MAX_CHARS} characters; shorten it`,
      )
    if (containsSecretShaped(value))
      throw new Error('claim resource contains secret-shaped text; remove the credential and retry')
  }
  return { kind, value }
}

export function claimNote(note: string | undefined): string | null | undefined {
  if (note === undefined) return undefined
  const value = note.trim()
  if (!value) return null
  if (value.length > BOARD_BODY_MAX_CHARS)
    throw new Error(`claim note exceeds ${BOARD_BODY_MAX_CHARS} characters; shorten it`)
  if (containsSecretShaped(value))
    throw new Error('claim note contains secret-shaped text; remove the credential and retry')
  return value
}

export function claimDurationRefusal(durationMs: number): string | null {
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || durationMs > BOARD_CLAIM_MAX_MS)
    return `claim duration must be positive and at most ${BOARD_CLAIM_MAX_MS}ms`
  return null
}
