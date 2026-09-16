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
  | { state: 'empty' | 'superseded' | 'unlanded' | 'unknown' }

export function decideBranchState(input: {
  branch: string
  mergedPullRequests: readonly MergedPullRequest[]
  mergedPullRequestsTruncated: boolean
  commitsNotOnTrunk: number
  patchEquivalent: PatchEquivalentForm | null
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
  if (input.superseded) return { state: 'superseded' }
  if (input.mergedPullRequestsTruncated) return { state: 'unknown' }
  return { state: 'unlanded' }
}
