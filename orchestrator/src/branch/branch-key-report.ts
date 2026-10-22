// concern: branches
/** Builds one task key's run-branch report from gathered repository facts. */

import type { Project } from '../project/projects.ts'
import { decideBranchContainment } from './branch-containment.ts'
import { observeBranchLandingProof } from './branch-proof-observer.ts'
import {
  type BranchLandingRecord,
  type BranchStateDecision,
  decideBranchState,
  findRecordedBranchLanding,
  shouldSettleTruncatedBranch,
  type TaskBranchPullRequestCheck,
} from './branch-state.ts'
import type { MergedPullRequest } from './merged-pull-request.ts'
import {
  isTaskBranchSuperseded,
  taskBranchContainedTips,
  taskBranchIsAncestor,
  taskBranchPullRequestCheck,
  taskBranchRunRow,
} from './task-branch.ts'

export type BranchReportRun = {
  record_id: string
  number: number
  parent_run_record_id: string | null
  launch_key: string | null
  branch: string | null
  launch_base: string | null
  status: string
}

export type BranchReportRow = BranchStateDecision & {
  branch: string
  tip: string
  commitsNotOnTrunk: number
  checkedOut: boolean
  liveRun: boolean
  runIds: number[]
}

type Input = {
  project: Project
  key: string
  byBranch: ReadonlyMap<string, BranchReportRun[]>
  runs: readonly BranchReportRun[]
  branches: ReadonlyMap<string, string>
  trunkTip: string
  pullRequests: readonly MergedPullRequest[]
  fetchedPullRequests: Map<number, string | null>
  recordedLandings: readonly BranchLandingRecord[]
  checkedOut: ReadonlySet<string>
  truncated: boolean
}

function decideProof(
  input: Input,
  row: ReturnType<typeof observeBranchLandingProof>,
  proof: {
    containingBranch?: string | null
    laterTurnBranches?: { branch: string; state: BranchStateDecision }[]
    superseded?: boolean
    targetedPullRequests?: TaskBranchPullRequestCheck | null
  } = {},
) {
  return decideBranchState({
    branch: row.branch,
    tip: row.tip,
    mergedPullRequests: row.matchingPr
      ? input.pullRequests
      : input.pullRequests.filter((pullRequest) => pullRequest.headRefName !== row.branch),
    mergedPullRequestsTruncated: input.truncated,
    commitsNotOnTrunk: row.commitsNotOnTrunk,
    patchEquivalent: row.patchEquivalent,
    pullRequestCommitCheck: row.pullRequestCommitCheck,
    recordedLanding: findRecordedBranchLanding(
      input.recordedLandings,
      input.project.name,
      row.branch,
    ),
    containingBranch: proof.containingBranch ?? null,
    laterTurnBranches: proof.laterTurnBranches ?? [],
    superseded: proof.superseded ?? false,
    targetedPullRequests: proof.targetedPullRequests ?? null,
  })
}

function containmentProofs(
  input: Input,
  rows: ReturnType<typeof observeBranchLandingProof>[],
  targetedPullRequests: ReadonlyMap<string, TaskBranchPullRequestCheck> = new Map(),
): ReadonlyMap<string, string> {
  const direct = new Map(
    rows.map((row) => [
      row.branch,
      decideProof(input, row, {
        targetedPullRequests: targetedPullRequests.get(row.branch) ?? null,
      }),
    ]),
  )
  const containedTips = taskBranchContainedTips(
    rows.map((row) => row.tip),
    (ancestor, descendant) => taskBranchIsAncestor(input.project.path, ancestor, descendant),
  )
  return decideBranchContainment(
    rows.map((row) => ({
      branch: row.branch,
      directlyLanded: direct.get(row.branch)?.state === 'landed',
      containingBranches: rows.flatMap((candidate) =>
        candidate.branch !== row.branch &&
        candidate.tip !== row.tip &&
        containedTips.has(row.tip) &&
        taskBranchIsAncestor(input.project.path, row.tip, candidate.tip)
          ? [candidate.branch]
          : [],
      ),
    })),
  )
}

type ObservedReportRow = ReturnType<typeof observeBranchLandingProof> & {
  runIds: number[]
  superseded: boolean
  turns: ReadonlyMap<string, number>
}

function decideObservedRows(
  input: Input,
  observed: readonly ObservedReportRow[],
  containedBy: ReadonlyMap<string, string>,
  targetedPullRequests: ReadonlyMap<string, TaskBranchPullRequestCheck> = new Map(),
): Map<string, BranchStateDecision> {
  const decided = new Map<string, BranchStateDecision>()
  for (const row of [...observed].sort(
    (left, right) => Math.max(...right.runIds) - Math.max(...left.runIds),
  )) {
    const laterTurnBranches = observed.flatMap((candidate) => {
      if (
        candidate.branch === row.branch ||
        ![...row.turns].some(
          ([root, turn]) => (candidate.turns.get(root) ?? Number.NEGATIVE_INFINITY) > turn,
        )
      )
        return []
      const state = decided.get(candidate.branch)
      return state ? [{ branch: candidate.branch, state }] : []
    })
    decided.set(
      row.branch,
      decideProof(input, row, {
        containingBranch: containedBy.get(row.branch) ?? null,
        laterTurnBranches,
        superseded: row.superseded,
        targetedPullRequests: targetedPullRequests.get(row.branch) ?? null,
      }),
    )
  }
  return decided
}

function gatherTargetedPullRequests(
  input: Input,
  rows: readonly ReturnType<typeof observeBranchLandingProof>[],
  preliminaryDecided: ReadonlyMap<string, BranchStateDecision>,
  preliminaryContainedBy: ReadonlyMap<string, string>,
): Map<string, TaskBranchPullRequestCheck> {
  const targeted = new Map<string, TaskBranchPullRequestCheck>()
  for (const row of rows) {
    const state =
      preliminaryDecided.get(row.branch) ??
      decideProof(input, row, {
        containingBranch: preliminaryContainedBy.get(row.branch) ?? null,
      })
    if (!shouldSettleTruncatedBranch(input.truncated, state)) continue
    targeted.set(
      row.branch,
      taskBranchPullRequestCheck({
        project: input.project,
        branch: row.branch,
        tip: row.tip,
        launchKey: input.key,
        headMatch: 'exact-head-contains-tip',
      }),
    )
  }
  return targeted
}

export function branchKeyReport(input: Input): { key: string; branches: BranchReportRow[] } {
  const keyRows = input.runs
    .filter((run) => (run.launch_key ?? 'unkeyed') === input.key && run.branch !== null)
    .map(taskBranchRunRow)
  const observe = (branch: string) =>
    observeBranchLandingProof({
      project: input.project,
      branch,
      tip: input.branches.get(branch)!,
      trunkTip: input.trunkTip,
      key: input.key,
      pullRequests: input.pullRequests,
      fetchedPullRequests: input.fetchedPullRequests,
    })
  const observed = [...input.byBranch].map(([branch, branchRuns]) => ({
    ...observe(branch),
    checkedOut: input.checkedOut.has(branch),
    liveRun: branchRuns.some((run) => run.status === 'running' || run.status === 'asking'),
    runIds: branchRuns.map((run) => run.number),
    recordedLanding: findRecordedBranchLanding(input.recordedLandings, input.project.name, branch),
    superseded: isTaskBranchSuperseded(branch, keyRows),
    turns: new Map(
      branchRuns.map((run) => [run.parent_run_record_id ?? run.record_id, run.number] as const),
    ),
  }))
  const taskProofs = [...new Set(keyRows.map((row) => row.branch))]
    .filter((branch) => input.branches.has(branch) && !input.byBranch.has(branch))
    .map(observe)
  const allProofs = [...observed, ...taskProofs]
  const preliminaryContainedBy = containmentProofs(input, allProofs)
  const preliminaryDecided = decideObservedRows(input, observed, preliminaryContainedBy)
  const targetedPullRequests = gatherTargetedPullRequests(
    input,
    allProofs,
    preliminaryDecided,
    preliminaryContainedBy,
  )
  const containedBy = containmentProofs(input, allProofs, targetedPullRequests)
  const decided = decideObservedRows(input, observed, containedBy, targetedPullRequests)
  return {
    key: input.key,
    branches: observed
      .sort((left, right) => left.branch.localeCompare(right.branch))
      .map(
        ({
          patchEquivalent: _,
          matchingPr: _m,
          pullRequestCommitCheck: _p,
          recordedLanding: _r,
          superseded: _s,
          turns: _t,
          ...row
        }) => ({
          ...row,
          ...decided.get(row.branch)!,
        }),
      ),
  }
}
