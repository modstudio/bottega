// concern: ship cleanup decision
/** Selects branch-owned ephemeral run data without filesystem or database access. */

import type { BranchStateDecision } from '../branch/branch-state.ts'
import {
  decideUnjudgedRunRemedy,
  providerDidNotServeRun,
  type UnjudgedRunRemedy,
} from '../cleanup/unjudged-run-remedy.ts'
import { TERMINAL_RUN_STATUS_SET } from '../run/run-status.ts'
import { HOOK_TREE_JOB, LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'

// Architect-owned trees, from `tree open` and `tree create`, are released by tree removal, never close-out.
const ARCHITECT_TREE_JOBS: ReadonlySet<string> = new Set([LANDING_TREE_JOB, HOOK_TREE_JOB])
export const SHIP_CLEANUP_RESIDUE_EXIT_CODE = 20

export type ShipCleanupRunFact = {
  record_id: string
  number: number
  root_record_id: string
  rootNumber: number
  startedAt: string
  job: string
  status: string
  branch: string | null
  mintedBranch: string | null
  launchKey: string | null
  judged: boolean
  failureKind: string | null
  rootFailureKind: string | null
  worktree: string | null
}

type ShipCleanupKeptOwner = 'caller-landing-tree' | 'other'

export type ShipCleanupKeptItem = {
  item: string
  reason: string
  reasonKind: ShipCleanupKeptReasonKind
  owner: ShipCleanupKeptOwner
  remedy?: string
}

export type ShipCleanupKeptFact = Omit<ShipCleanupKeptItem, 'owner'> & {
  holdingPath: string | null
}

/** Assign ownership only when the item is held by the command's own landing tree. */
export function decideShipCleanupKeptItem(
  fact: ShipCleanupKeptFact,
  callerLandingTreePath: string | null,
): ShipCleanupKeptItem {
  const { holdingPath, ...item } = fact
  return {
    ...item,
    owner:
      holdingPath !== null && holdingPath === callerLandingTreePath
        ? 'caller-landing-tree'
        : 'other',
  }
}

export type ShipCleanupResidueReport = {
  kept: readonly ShipCleanupKeptItem[]
  errors: readonly unknown[]
}

type ShipCleanupKeptReasonKind =
  | 'command-tree'
  | 'live-run'
  | 'unjudged-run'
  | 'landing-not-proved'
  | 'safety-hold'
  | 'cleanup-failure'

export type ShipCleanupVerdict =
  | { clean: true; residue: readonly ShipCleanupKeptItem[] }
  | {
      clean: false
      reason: 'errors' | 'unexpected-kept-item'
      residue: readonly ShipCleanupKeptItem[]
    }

/** Judge residue independently of items owned by the caller's landing tree. */
export function decideShipCleanupVerdict(report: ShipCleanupResidueReport): ShipCleanupVerdict {
  const residue = report.kept.filter((item) => item.owner === 'other')
  if (report.errors.length > 0) return { clean: false, reason: 'errors', residue }
  if (residue.length === 0) return { clean: true, residue }
  return { clean: false, reason: 'unexpected-kept-item', residue }
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
  remedy?: UnjudgedRunRemedy
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

function outsideScopeReason(run: ShipCleanupRunFact, landingMergedAt: string): string {
  if (!startedByLanding(run.startedAt, landingMergedAt)) {
    return `run started after branch landed at ${landingMergedAt}`
  }
  if (!run.launchKey) return 'run has no task key'
  if (!run.branch) return 'run has no branch'
  return `run belongs to branch ${run.branch}`
}

function decideScopedRun(
  run: ShipCleanupRunFact,
  scope: ShipCleanupRunDecision['scope'],
  landingMergedAt: string,
  liveChainRun: ShipCleanupRunFact | undefined,
): ShipCleanupRunDecision {
  if (scope === 'outside') {
    return {
      ...run,
      scope,
      artifacts: 'ignore',
      worktreeAction: 'ignore',
      reason: outsideScopeReason(run, landingMergedAt),
    }
  }
  if (scope === 'chain' && liveChainRun && liveChainRun.record_id !== run.record_id) {
    return {
      ...run,
      scope,
      artifacts: 'keep',
      worktreeAction: 'keep',
      reason: `run ${liveChainRun.number} is live (${liveChainRun.status})`,
    }
  }
  if (!TERMINAL_RUN_STATUS_SET.has(run.status)) {
    return {
      ...run,
      scope,
      artifacts: 'keep',
      worktreeAction: 'keep',
      reason: `run is live (${run.status})`,
    }
  }
  if (!run.judged) {
    if (providerDidNotServeRun(run.failureKind)) {
      return {
        ...run,
        scope,
        artifacts: 'remove',
        worktreeAction: 'close',
        reason: `provider did not serve the run (${run.failureKind}); nothing to judge`,
      }
    }
    return {
      ...run,
      scope,
      artifacts: 'keep',
      worktreeAction: 'close',
      reason: 'run has no recorded verdict',
      ...(run.record_id === run.root_record_id
        ? { remedy: decideUnjudgedRunRemedy(run.rootFailureKind) }
        : {}),
    }
  }
  return {
    ...run,
    scope,
    artifacts: 'remove',
    worktreeAction: 'close',
    reason: 'terminal judged run on merged branch',
  }
}

/** Decide removal for each run while keeping every member of a chain with a live turn. */
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
  const liveChainRuns = new Map<string, ShipCleanupRunFact>()
  for (const run of runs) {
    if (!TERMINAL_RUN_STATUS_SET.has(run.status) && !liveChainRuns.has(run.root_record_id)) {
      liveChainRuns.set(run.root_record_id, run)
    }
  }
  return runs.map((run) => {
    const scope = scopeFor(run, taskKey, landedBranches, landingMergedAt, branchChainRoots)
    return decideScopedRun(run, scope, landingMergedAt, liveChainRuns.get(run.root_record_id))
  })
}
