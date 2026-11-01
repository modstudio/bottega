// concern: branch-state
/** Decides a run-minted branch's reported state from already-observed facts. */

import type { MergedPullRequest, PullRequestCommitCheck } from './merged-pull-request.ts'

export type TaskBranchPullRequestCheck =
  | {
      state: 'landed'
      landedBy: 'name'
      number: number
      pullRequest: MergedPullRequest
    }
  | { state: 'landed'; landedBy: 'pr-commits'; number: number }
  | { state: 'closed-unmerged'; number: number }
  | { state: 'unmatched' }
  | { state: 'unknown'; reason: string }

export function pullRequestCarriesKey(
  pullRequest: Pick<MergedPullRequest, 'headRefName' | 'title'>,
  key: string,
): boolean {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const token = new RegExp(`(^|[^A-Za-z0-9])${escaped}($|[^A-Za-z0-9])`)
  return token.test(pullRequest.headRefName) || token.test(pullRequest.title)
}

export type PatchEquivalentForm = 'commits' | 'individual' | 'squash'

export function branchMatchesFilter(
  branch: string,
  key: string,
  filter: { branch?: string; key?: string },
): boolean {
  return (
    (filter.branch === undefined || branch === filter.branch) &&
    (filter.key === undefined || key === filter.key)
  )
}

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
  | {
      state: 'landed'
      landedBy: { type: 'contained'; branch: string }
    }
  | { state: 'empty' | 'superseded' | 'unlanded' }
  | { state: 'unknown'; error?: string }

export type BranchStateDecision = BranchLanding & {
  note?: typeof STALE_RECORDED_LANDING
}

type TargetedBranchLandingDecision =
  | Extract<BranchLanding, { landedBy: { type: 'pr' | 'pr-commits' } }>
  | { state: 'unlanded' }
  | { state: 'unknown'; error?: string }

/** Translate the shared targeted task-branch result into branch-report vocabulary. */
function targetedBranchLandingDecision(
  check: TaskBranchPullRequestCheck,
): TargetedBranchLandingDecision {
  if (check.state === 'landed' && check.landedBy === 'name') {
    const pullRequest = check.pullRequest
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
  if (check.state === 'landed') {
    return {
      state: 'landed',
      landedBy: { type: 'pr-commits', number: check.number },
    }
  }
  if (check.state === 'unknown') return { state: 'unknown', error: check.reason }
  return { state: 'unlanded' }
}

/** Settles the fallback after every non-forge landing proof has been exhausted. */
export function decideUnmatchedBranchLanding(
  mergedPullRequestsTruncated: boolean,
  targetedPullRequests: TaskBranchPullRequestCheck | null,
): TargetedBranchLandingDecision {
  if (!mergedPullRequestsTruncated) return { state: 'unlanded' }
  return targetedPullRequests
    ? targetedBranchLandingDecision(targetedPullRequests)
    : { state: 'unknown' }
}

/** Whether capped global evidence needs the shared targeted forge settlement. */
export function shouldSettleTruncatedBranch(
  mergedPullRequestsTruncated: boolean,
  preliminary: { state: string; error?: string },
): boolean {
  return mergedPullRequestsTruncated && preliminary.state === 'unknown' && !preliminary.error
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
  containingBranch: string | null
  laterTurnBranches: readonly LaterTurnBranch[]
  superseded: boolean
  targetedPullRequests: TaskBranchPullRequestCheck | null
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
  if (input.containingBranch) {
    return decide({
      state: 'landed',
      landedBy: { type: 'contained', branch: input.containingBranch },
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
  return decide(
    decideUnmatchedBranchLanding(input.mergedPullRequestsTruncated, input.targetedPullRequests),
  )
}

export type PruneEligibility =
  | { eligible: true }
  | {
      eligible: false
      reason: 'throwaway' | 'unlanded' | 'unknown' | 'checked-out' | 'live' | 'tip-moved'
    }

type PruneEligibilityReason = Extract<PruneEligibility, { eligible: false }>['reason']

export type BranchPruneKeptReason =
  | PruneEligibilityReason
  | 'state'
  | 'held'
  | 'protected'
  | `base of live run ${string} (${string})`
  | 'tip could not be rechecked'
  | `registered ${ProtectedBranchKind}`
  | 'deletion failed'

export function isPruneSafeLandingState(
  state: BranchLanding['state'],
): state is 'landed' | 'superseded' | 'empty' {
  return state === 'landed' || state === 'superseded' || state === 'empty'
}

export type MintedBranchVerdict =
  | { verdict: 'delete' }
  | { verdict: 'throwaway' }
  | { verdict: 'keep'; reason: 'unlanded' | 'unknown' }

export function isProbeOnlyMint(probes: readonly boolean[]): boolean {
  return probes.length > 0 && probes.every(Boolean)
}

/** Is this branch's work preserved elsewhere (landed, superseded by a recorded successor, or empty), so deleting the ref loses nothing? */
export function decideMintedBranchVerdict(input: {
  state: BranchStateDecision['state']
  probeOnly: boolean
}): MintedBranchVerdict {
  if (isPruneSafeLandingState(input.state)) return { verdict: 'delete' }
  if (input.probeOnly) return { verdict: 'throwaway' }
  return { verdict: 'keep', reason: input.state === 'unknown' ? 'unknown' : 'unlanded' }
}

/** Decides whether an observed branch may be deleted, without performing any I/O. */
export function decidePruneEligibility(input: {
  state: BranchLanding['state']
  probeOnly: boolean
  checkedOut: boolean
  liveRun: boolean
  tipMoved: boolean
}): PruneEligibility {
  const verdict = decideMintedBranchVerdict(input)
  if (verdict.verdict !== 'delete')
    return {
      eligible: false,
      reason: verdict.verdict === 'keep' ? verdict.reason : verdict.verdict,
    }
  if (input.checkedOut) return { eligible: false, reason: 'checked-out' }
  if (input.liveRun) return { eligible: false, reason: 'live' }
  if (input.tipMoved) return { eligible: false, reason: 'tip-moved' }
  return { eligible: true }
}
