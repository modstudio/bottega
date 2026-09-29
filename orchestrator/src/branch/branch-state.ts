// concern: branch-state
/** Decides a run-minted branch's reported state from already-observed facts. */

import type { MergedPullRequest, PullRequestCommitCheck } from './merged-pull-request.ts'

export function pullRequestCarriesKey(
  pullRequest: Pick<MergedPullRequest, 'headRefName' | 'title'>,
  key: string,
): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const token = new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`)
  return token.test(pullRequest.headRefName) || token.test(pullRequest.title)
}

export type PatchEquivalentForm = 'commits' | 'individual' | 'squash'

type RecordedBranchLanding = {
  number: number
  mergeCommit: string | null
  mergedAt: string
}

export type StoredRecordedBranchLanding = RecordedBranchLanding & { tip: string }

export type BranchLandingRecord = StoredRecordedBranchLanding & {
  project: string
  branch: string
}

export function findRecordedBranchLanding(
  records: readonly BranchLandingRecord[],
  project: string,
  branch: string,
): StoredRecordedBranchLanding | null {
  const record = records.find(
    (candidate) => candidate.project === project && candidate.branch === branch,
  )
  if (!record) return null
  const { project: _project, branch: _branch, ...landing } = record
  return landing
}

const STALE_RECORDED_LANDING = 'recorded landing stale (branch advanced)' as const

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
  | { state: 'landed'; landedBy: { type: 'pr-commits'; number: number } }
  | {
      state: 'landed'
      landedBy: { type: 'recorded' } & RecordedBranchLanding
    }
  | {
      state: 'landed'
      landedBy: { type: 'turn'; branch: string }
    }
  | { state: 'empty' | 'superseded' | 'unlanded' }
  | { state: 'unknown'; error?: string }

export type BranchStateDecision = BranchLanding & {
  note?: typeof STALE_RECORDED_LANDING
}

export type ProtectedBranchKind = 'trunk' | 'production'

/** Decides whether a branch is reserved by the project's registered branch settings. */
export function decideProtectedBranch(input: {
  branch: string
  trunk: string
  productionBranch: string
}): ProtectedBranchKind | null {
  if (input.branch === input.trunk) return 'trunk'
  if (input.productionBranch && input.branch === input.productionBranch) return 'production'
  return null
}

type LaterTurnBranch = { branch: string; state: BranchLanding }

export function decideBranchState(input: {
  branch: string
  tip: string
  mergedPullRequests: readonly MergedPullRequest[]
  mergedPullRequestsTruncated: boolean
  commitsNotOnTrunk: number
  patchEquivalent: PatchEquivalentForm | null
  pullRequestCommitCheck: PullRequestCommitCheck
  recordedLanding: StoredRecordedBranchLanding | null
  laterTurnBranches: readonly LaterTurnBranch[]
  superseded: boolean
}): BranchStateDecision {
  const staleRecordedLanding =
    input.recordedLanding !== null && input.recordedLanding.tip !== input.tip
  const decide = (state: BranchLanding): BranchStateDecision =>
    staleRecordedLanding ? { ...state, note: STALE_RECORDED_LANDING } : state
  const pullRequest = input.mergedPullRequests.find((pr) => pr.headRefName === input.branch)
  if (pullRequest) {
    return decide({
      state: 'landed',
      landedBy: {
        type: 'pr',
        number: pullRequest.number,
        mergeCommit: pullRequest.mergeCommit?.oid ?? null,
        mergedAt: pullRequest.mergedAt,
      },
    })
  }
  if (input.recordedLanding && !staleRecordedLanding) {
    const { tip: _tip, ...landing } = input.recordedLanding
    return decide({
      state: 'landed',
      landedBy: { type: 'recorded', ...landing },
    })
  }
  if (input.commitsNotOnTrunk === 0) return decide({ state: 'empty' })
  if (input.patchEquivalent) {
    return decide({
      state: 'landed',
      landedBy: { type: 'patch-equivalent', form: input.patchEquivalent },
    })
  }
  if (input.pullRequestCommitCheck && 'number' in input.pullRequestCommitCheck) {
    return decide({
      state: 'landed',
      landedBy: { type: 'pr-commits', number: input.pullRequestCommitCheck.number },
    })
  }
  const landedTurn = input.laterTurnBranches.find(
    (candidate) => candidate.state.state === 'landed' && candidate.state.landedBy.type !== 'turn',
  )
  if (landedTurn) {
    return decide({
      state: 'landed',
      landedBy: { type: 'turn', branch: landedTurn.branch },
    })
  }
  if (input.superseded) return decide({ state: 'superseded' })
  if (input.pullRequestCommitCheck && 'error' in input.pullRequestCommitCheck) {
    return decide({ state: 'unknown', error: input.pullRequestCommitCheck.error })
  }
  if (input.mergedPullRequestsTruncated) return decide({ state: 'unknown' })
  return decide({ state: 'unlanded' })
}

type PruneEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'state' | 'checked-out' | 'live' | 'tip-moved' }

export function isPruneSafeLandingState(
  state: BranchLanding['state'],
): state is 'landed' | 'superseded' | 'empty' {
  return state === 'landed' || state === 'superseded' || state === 'empty'
}

/** Decides whether an observed branch may be deleted, without performing any I/O. */
export function decidePruneEligibility(input: {
  state: BranchLanding['state']
  checkedOut: boolean
  liveRun: boolean
  tipMoved: boolean
}): PruneEligibility {
  if (!isPruneSafeLandingState(input.state)) {
    return { eligible: false, reason: 'state' }
  }
  if (input.checkedOut) return { eligible: false, reason: 'checked-out' }
  if (input.liveRun) return { eligible: false, reason: 'live' }
  if (input.tipMoved) return { eligible: false, reason: 'tip-moved' }
  return { eligible: true }
}
