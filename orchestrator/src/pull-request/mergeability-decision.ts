// concern: pull-request mergeability
/** Decides whether GitHub's mergeability state needs another read or a user-facing report. */

export type MergeabilityDecision =
  | { kind: 'clear' }
  | { kind: 'poll' }
  | { kind: 'report'; conflict: boolean; message: string }

export type MergeabilityFacts = {
  mergeStateStatus: string
  url: string
  landingBranch: string
  boundReached: boolean
}

export function decideMergeability(input: MergeabilityFacts): MergeabilityDecision {
  const status = input.mergeStateStatus.toUpperCase()
  if (status === 'DIRTY') {
    return {
      kind: 'report',
      conflict: true,
      message: `${input.url} conflicts with ${input.landingBranch}: rebase it on the landing branch before merging`,
    }
  }
  if (status !== 'UNKNOWN') return { kind: 'clear' }
  if (!input.boundReached) return { kind: 'poll' }
  return {
    kind: 'report',
    conflict: false,
    message: `mergeability not yet known for ${input.url}`,
  }
}
