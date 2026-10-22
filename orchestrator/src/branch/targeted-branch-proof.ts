// concern: branches
/** Gathers narrow forge facts when the global merged-PR listing is insufficient. */

import type { Project } from '../project/projects.ts'
import { matchAutomaticBranchLandingForTip } from './branch-landing-match.ts'
import { pullRequestCarriesKey, type TargetedBranchLandingFacts } from './branch-state.ts'
import {
  type MergedPullRequest,
  pullRequestCommitCheck,
  pullRequestNameCheck,
  targetedMergedPullRequests,
  targetedTaskBranchPullRequests,
} from './merged-pull-request.ts'

type TargetedObservationInput = {
  project: Project
  branch: string
  tip: string
  key: string
  fetchedPullRequests: Map<number, string | null>
  headMatch?: 'tip' | 'contains-tip'
}

function targetedHeadMatch(
  input: TargetedObservationInput,
  pullRequests: readonly MergedPullRequest[],
): Pick<TargetedBranchLandingFacts, 'matchingPullRequest' | 'error'> {
  if (input.headMatch === 'contains-tip') {
    const nameCheck = pullRequestNameCheck(
      input.project,
      pullRequests,
      input.branch,
      input.tip,
      input.fetchedPullRequests,
    )
    if (nameCheck && 'error' in nameCheck) {
      return { matchingPullRequest: null, error: nameCheck.error }
    }
    return {
      matchingPullRequest:
        nameCheck && 'pullRequest' in nameCheck && nameCheck.containsTip
          ? nameCheck.pullRequest
          : null,
    }
  }
  const matching = matchAutomaticBranchLandingForTip(input.branch, input.tip, pullRequests)
  return {
    matchingPullRequest: matching
      ? (pullRequests.find((pullRequest) => pullRequest.number === matching.pullRequest.number) ??
        null)
      : null,
  }
}

export function observeTargetedBranchLandingFacts(
  input: TargetedObservationInput,
): TargetedBranchLandingFacts {
  try {
    const branchListing = targetedTaskBranchPullRequests(input.project, input.branch)
    const commitListing =
      input.key === 'unkeyed'
        ? { pullRequests: [] as MergedPullRequest[], truncated: false }
        : targetedMergedPullRequests(input.project, { search: input.key })
    const mergedBranchPullRequests = branchListing.pullRequests.filter(
      (pullRequest): pullRequest is MergedPullRequest =>
        pullRequest.state === 'MERGED' && pullRequest.mergedAt !== null,
    )
    const { matchingPullRequest, error } = targetedHeadMatch(input, mergedBranchPullRequests)
    return {
      matchingPullRequest,
      pullRequestCommitCheck:
        input.key === 'unkeyed' || matchingPullRequest
          ? null
          : pullRequestCommitCheck(
              input.project,
              commitListing.pullRequests.filter((pullRequest) =>
                pullRequestCarriesKey(pullRequest, input.key),
              ),
              input.tip,
              input.fetchedPullRequests,
            ),
      branchListingTruncated: branchListing.truncated,
      commitListingTruncated: commitListing.truncated,
      ...(error ? { error } : {}),
    }
  } catch (error) {
    return {
      matchingPullRequest: null,
      pullRequestCommitCheck: null,
      branchListingTruncated: false,
      commitListingTruncated: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}
