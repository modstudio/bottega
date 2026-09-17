// concern: branch-state
/** Pure policy for local branches that were not minted by an orchestrator run. */

import type {
  MergedPullRequest,
  PatchEquivalentForm,
  ProtectedBranchKind,
  PullRequestCommitCheck,
} from './branch-state.ts'

export type OtherBranchLanding =
  | {
      state: 'landed'
      landedBy: {
        type: 'pr'
        number: number
        mergeCommit: string | null
        mergedAt: string
      }
    }
  | { state: 'landed'; landedBy: { type: 'patch-equivalent'; form: PatchEquivalentForm } }
  | { state: 'landed'; landedBy: { type: 'pr-commits'; number: number } }
  | { state: 'empty' | 'unlanded' | 'held' }
  | { state: 'unknown'; error?: string }

export function isHeldBranch(branch: string): boolean {
  return (
    branch.endsWith('-keep') || branch.includes('-escaped-keep') || branch.includes('-wip-keep')
  )
}

export function taskKeyToken(branch: string, prefixes: readonly string[]): string | null {
  for (const prefix of prefixes) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const match = branch.match(
      new RegExp(`(?:^|[^A-Za-z0-9])(${escaped}-[0-9]+)(?:$|[^A-Za-z0-9])`),
    )
    if (match?.[1]) return match[1]
  }
  return null
}

/** Decides the displayed state of one non-run local branch from observed facts. */
export function decideOtherBranchState(input: {
  branch: string
  mergedPullRequests: readonly MergedPullRequest[]
  mergedPullRequestsTruncated: boolean
  commitsNotOnTrunk: number
  patchEquivalent: PatchEquivalentForm | null
  pullRequestCommitCheck: PullRequestCommitCheck
  checkError?: string
}): OtherBranchLanding {
  if (isHeldBranch(input.branch)) return { state: 'held' }
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
  if (input.checkError) return { state: 'unknown', error: input.checkError }
  if (input.commitsNotOnTrunk === 0) return { state: 'empty' }
  if (input.patchEquivalent) {
    return { state: 'landed', landedBy: { type: 'patch-equivalent', form: input.patchEquivalent } }
  }
  if (input.pullRequestCommitCheck && 'number' in input.pullRequestCommitCheck) {
    return {
      state: 'landed',
      landedBy: { type: 'pr-commits', number: input.pullRequestCommitCheck.number },
    }
  }
  const error =
    input.pullRequestCommitCheck && 'error' in input.pullRequestCommitCheck
      ? input.pullRequestCommitCheck.error
      : undefined
  if (error) return { state: 'unknown', error }
  if (input.mergedPullRequestsTruncated) return { state: 'unknown' }
  return { state: 'unlanded' }
}

type OtherPruneEligibility =
  | { eligible: true }
  | {
      eligible: false
      reason: 'state' | 'held' | 'checked-out' | 'protected' | 'tip-moved'
    }

/** Decides whether an observed non-run branch may be deleted. */
export function decideOtherPruneEligibility(input: {
  state: OtherBranchLanding['state']
  held: boolean
  checkedOut: boolean
  protectedKind: ProtectedBranchKind | null
  tipMoved: boolean
}): OtherPruneEligibility {
  if (input.held) return { eligible: false, reason: 'held' }
  if (input.protectedKind) return { eligible: false, reason: 'protected' }
  if (!['landed', 'empty'].includes(input.state)) return { eligible: false, reason: 'state' }
  if (input.checkedOut) return { eligible: false, reason: 'checked-out' }
  if (input.tipMoved) return { eligible: false, reason: 'tip-moved' }
  return { eligible: true }
}
