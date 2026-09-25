// concern: pull-request-pre-push-decision
/** Pure policy for deciding whether one destination ref needs and passes triage. */

export type PrePushDecision =
  | { admit: true; check: false; reason: 'non-branch' | 'unknown-branch' }
  | { admit: true; check: true; reason: 'complete' | 'infrastructure-unavailable' }
  | { admit: false; check: true; reason: 'incomplete' }

export function destinationBranch(remoteRef: string): string | null {
  const prefix = 'refs/heads/'
  return remoteRef.startsWith(prefix) && remoteRef.length > prefix.length
    ? remoteRef.slice(prefix.length)
    : null
}

export function decidePrePush(input: {
  remoteRef: string
  recordedBranches: readonly string[]
  triageComplete: boolean | null
}): PrePushDecision {
  const branch = destinationBranch(input.remoteRef)
  if (branch === null) return { admit: true, check: false, reason: 'non-branch' }
  if (!input.recordedBranches.includes(branch)) {
    return { admit: true, check: false, reason: 'unknown-branch' }
  }
  if (input.triageComplete === null) {
    return { admit: true, check: true, reason: 'infrastructure-unavailable' }
  }
  return input.triageComplete
    ? { admit: true, check: true, reason: 'complete' }
    : { admit: false, check: true, reason: 'incomplete' }
}
