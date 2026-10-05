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

export const claimIsLive = (input: ClaimLiveness): boolean => claimCloseReason(input) === null

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
  conflictingLive: boolean
  force: boolean
  actorKind: ClaimActor['kind']
}): ClaimTakeDecision {
  if (input.sameHolderSameSubject && input.conflictingLive) return 'renew'
  if (!input.conflictingClaim) return 'take'
  if (!input.conflictingLive || (input.force && input.actorKind === 'operator')) return 'take-over'
  return 'refuse'
}

export const sameClaimHolder = (actor: ClaimActor, holder: ClaimActor): boolean =>
  actor.kind === holder.kind && actor.session === holder.session

export const mayRenewClaim = (actor: ClaimActor, holder: ClaimActor): boolean =>
  sameClaimHolder(actor, holder)

export const mayReleaseClaim = (actor: ClaimActor, holder: ClaimActor): boolean =>
  actor.kind === 'operator' || sameClaimHolder(actor, holder)

export const mayForceClaim = (actor: ClaimActor): boolean => actor.kind === 'operator'
