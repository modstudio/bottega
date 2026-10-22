// concern: ship cleanup decision
/** Selects branch-owned ephemeral run data without filesystem or database access. */

import type { BranchStateDecision } from '../branch/branch-state.ts'
import { HOOK_TREE_JOB, LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'

const SHIP_CLEANUP_TERMINAL_STATUSES = new Set(['ok', 'failed', 'stale', 'stopped'])
// Architect-owned trees, from `tree open` and `tree create`, are released by tree removal, never close-out.
const ARCHITECT_TREE_JOBS: ReadonlySet<string> = new Set([LANDING_TREE_JOB, HOOK_TREE_JOB])
export const SHIP_CLEANUP_RESIDUE_EXIT_CODE = 20

export type ShipCleanupRunFact = {
  record_id: string
  number: number
  root_record_id: string
  startedAt: string
  job: string
  status: string
  branch: string | null
  mintedBranch: string | null
  launchKey: string | null
  judged: boolean
  worktree: string | null
}

export type ShipCleanupResidueReport = {
  kept: readonly { item: string; reason: string; reasonKind: ShipCleanupKeptReasonKind }[]
  errors: readonly unknown[]
}

export type ShipCleanupKeptReasonKind =
  | 'command-tree'
  | 'live-run'
  | 'unjudged-run'
  | 'landing-not-proved'
  | 'safety-hold'
  | 'cleanup-failure'

export type ShipCleanupVerdict =
  | { clean: true }
  | { clean: false; reason: 'errors' | 'unexpected-kept-item' }

/** Judge whether cleanup left residue, optionally allowing its one caller-owned landing tree. */
export function decideShipCleanupVerdict(
  report: ShipCleanupResidueReport,
  allowCommandTree: boolean,
): ShipCleanupVerdict {
  if (report.errors.length > 0) return { clean: false, reason: 'errors' }
  if (report.kept.length === 0) return { clean: true }
  if (allowCommandTree && report.kept.length === 1 && report.kept[0]!.reasonKind === 'command-tree')
    return { clean: true }
  return { clean: false, reason: 'unexpected-kept-item' }
}

/** Select proved task branches and report every unproved run-minted sibling. */
export function decideTaskBranchesToPrune(
  taskKey: string,
  runs: readonly Pick<ShipCleanupRunFact, 'launchKey' | 'mintedBranch'>[],
  localBranches: ReadonlySet<string>,
  landingEvidence: ReadonlyMap<string, BranchStateDecision>,
): {
  delete: string[]
  landingProof: string[]
  keep: { branch: string; reason: 'landing not proved' }[]
  gone: string[]
} {
  const branches = [
    ...new Set(
      runs.flatMap((run) =>
        run.launchKey === taskKey && run.mintedBranch ? [run.mintedBranch] : [],
      ),
    ),
  ].sort()
  const existing = branches.filter((branch) => localBranches.has(branch))
  const landed = branches.filter((branch) => landingEvidence.get(branch)?.state === 'landed')
  return {
    delete: landed.filter((branch) => localBranches.has(branch)),
    landingProof: landed,
    keep: existing
      .filter((branch) => landingEvidence.get(branch)?.state !== 'landed')
      .map((branch) => ({ branch, reason: 'landing not proved' })),
    gone: branches.filter(
      (branch) => !localBranches.has(branch) && landingEvidence.get(branch)?.state !== 'landed',
    ),
  }
}

export type ShipCleanupRunDecision = ShipCleanupRunFact & {
  scope: 'chain' | 'review-lens' | 'landing-tree' | 'outside'
  artifacts: 'remove' | 'keep' | 'ignore'
  worktreeAction: 'close' | 'keep' | 'ignore'
  reason: string
}

function startedByLanding(startedAt: string, landingMergedAt: string): boolean {
  return Date.parse(startedAt) <= Date.parse(landingMergedAt)
}

function scopeFor(
  run: ShipCleanupRunFact,
  taskKey: string,
  landedBranches: ReadonlySet<string>,
  landingMergedAt: string,
  branchChainRoots: ReadonlySet<string>,
): ShipCleanupRunDecision['scope'] {
  if (!run.launchKey || !run.branch) return 'outside'
  if (!startedByLanding(run.startedAt, landingMergedAt)) return 'outside'
  if (run.launchKey !== taskKey) return 'outside'
  if (branchChainRoots.has(run.root_record_id)) return 'chain'
  if (!landedBranches.has(run.branch)) return 'outside'
  if (ARCHITECT_TREE_JOBS.has(run.job)) return 'landing-tree'
  if (run.job === 'review-lens') return 'review-lens'
  return 'outside'
}

/** Decide removal independently for each run; turns inherit their root verdict in gathered facts. */
export function decideShipCleanup(
  taskKey: string,
  landedBranches: ReadonlySet<string>,
  landingMergedAt: string,
  runs: readonly ShipCleanupRunFact[],
): ShipCleanupRunDecision[] {
  const branchChainRoots = new Set(
    runs
      .filter(
        (run) =>
          run.launchKey === taskKey &&
          startedByLanding(run.startedAt, landingMergedAt) &&
          run.branch !== null &&
          landedBranches.has(run.branch) &&
          run.job !== 'review-lens' &&
          !ARCHITECT_TREE_JOBS.has(run.job),
      )
      .map((run) => run.root_record_id),
  )
  return runs.map((run) => {
    const scope = scopeFor(run, taskKey, landedBranches, landingMergedAt, branchChainRoots)
    if (scope === 'outside') {
      return {
        ...run,
        scope,
        artifacts: 'ignore',
        worktreeAction: 'ignore',
        reason: !startedByLanding(run.startedAt, landingMergedAt)
          ? `run started after branch landed at ${landingMergedAt}`
          : !run.launchKey
            ? 'run has no task key'
            : !run.branch
              ? 'run has no branch'
              : `run belongs to branch ${run.branch}`,
      }
    }
    if (!SHIP_CLEANUP_TERMINAL_STATUSES.has(run.status)) {
      return {
        ...run,
        scope,
        artifacts: 'keep',
        worktreeAction: 'keep',
        reason: `run is live (${run.status})`,
      }
    }
    if (!run.judged) {
      return {
        ...run,
        scope,
        artifacts: 'keep',
        worktreeAction: 'close',
        reason: 'run has no recorded verdict',
      }
    }
    return {
      ...run,
      scope,
      artifacts: 'remove',
      worktreeAction: 'close',
      reason: 'terminal judged run on merged branch',
    }
  })
}
