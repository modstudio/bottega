// concern: branch-state
/** Decides a run-minted branch's reported state from already-observed facts. */

export type MergedPullRequest = {
  number: number
  headRefName: string
  mergeCommit: { oid: string } | null
  mergedAt: string
}

export type PatchEquivalentForm = 'commits' | 'squash'

export type BranchLanding =
  | {
      state: 'landed'
      landedBy: {
        type: 'pr'
        number: number
        mergeCommit: string | null
        mergedAt: string
      }
    }
  | {
      state: 'landed'
      landedBy: { type: 'patch-equivalent'; form: PatchEquivalentForm }
    }
  | {
      state: 'landed'
      landedBy: { type: 'turn'; branch: string }
    }
  | { state: 'empty' | 'superseded' | 'unlanded' | 'unknown' }

type LaterTurnBranch = { branch: string; state: BranchLanding }

export function decideBranchState(input: {
  branch: string
  mergedPullRequests: readonly MergedPullRequest[]
  mergedPullRequestsTruncated: boolean
  commitsNotOnTrunk: number
  patchEquivalent: PatchEquivalentForm | null
  laterTurnBranches: readonly LaterTurnBranch[]
  superseded: boolean
}): BranchLanding {
  const pullRequest = input.mergedPullRequests.find((pr) => pr.headRefName === input.branch)
  if (pullRequest) {
    return {
      state: 'landed',
      landedBy: {
        type: 'pr',
        number: pullRequest.number,
        mergeCommit: pullRequest.mergeCommit?.oid ?? null,
        mergedAt: pullRequest.mergedAt,
      },
    }
  }
  if (input.commitsNotOnTrunk === 0) return { state: 'empty' }
  if (input.patchEquivalent) {
    return {
      state: 'landed',
      landedBy: { type: 'patch-equivalent', form: input.patchEquivalent },
    }
  }
  const landedTurn = input.laterTurnBranches.find(
    (candidate) => candidate.state.state === 'landed' && candidate.state.landedBy.type !== 'turn',
  )
  if (landedTurn) {
    return {
      state: 'landed',
      landedBy: { type: 'turn', branch: landedTurn.branch },
    }
  }
  if (input.superseded) return { state: 'superseded' }
  if (input.mergedPullRequestsTruncated) return { state: 'unknown' }
  return { state: 'unlanded' }
}

type PruneEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'state' | 'checked-out' | 'live' | 'tip-moved' }

/** Decides whether an observed branch may be deleted, without performing any I/O. */
export function decidePruneEligibility(input: {
  state: BranchLanding['state']
  checkedOut: boolean
  liveRun: boolean
  tipMoved: boolean
}): PruneEligibility {
  if (!['landed', 'superseded', 'empty'].includes(input.state)) {
    return { eligible: false, reason: 'state' }
  }
  if (input.checkedOut) return { eligible: false, reason: 'checked-out' }
  if (input.liveRun) return { eligible: false, reason: 'live' }
  if (input.tipMoved) return { eligible: false, reason: 'tip-moved' }
  return { eligible: true }
}
