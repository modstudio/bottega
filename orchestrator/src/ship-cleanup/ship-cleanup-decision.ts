// concern: ship cleanup decision
/** Selects branch-owned ephemeral run data without filesystem or database access. */

import { HOOK_TREE_JOB, LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'

const SHIP_CLEANUP_TERMINAL_STATUSES = new Set(['ok', 'failed', 'stale', 'stopped'])
// Architect-owned trees, from `tree open` and `tree create`, are released by tree removal, never close-out.
const ARCHITECT_TREE_JOBS: ReadonlySet<string> = new Set([LANDING_TREE_JOB, HOOK_TREE_JOB])

export type ShipCleanupRunFact = {
  id: number
  rootId: number
  startedAt: string
  job: string
  status: string
  branch: string | null
  launchKey: string | null
  judged: boolean
  worktree: string | null
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
  branch: string,
  landingMergedAt: string,
  branchChainRoots: ReadonlySet<number>,
): ShipCleanupRunDecision['scope'] {
  if (!run.launchKey || !run.branch) return 'outside'
  if (!startedByLanding(run.startedAt, landingMergedAt)) return 'outside'
  if (ARCHITECT_TREE_JOBS.has(run.job) && run.branch === branch) return 'landing-tree'
  if (run.job === 'review-lens' && run.branch === branch) return 'review-lens'
  return branchChainRoots.has(run.rootId) ? 'chain' : 'outside'
}

/** Decide removal independently for each run; turns inherit their root verdict in gathered facts. */
export function decideShipCleanup(
  branch: string,
  landingMergedAt: string,
  runs: readonly ShipCleanupRunFact[],
): ShipCleanupRunDecision[] {
  const branchChainRoots = new Set(
    runs
      .filter(
        (run) =>
          run.launchKey &&
          startedByLanding(run.startedAt, landingMergedAt) &&
          run.branch === branch &&
          run.job !== 'review-lens' &&
          !ARCHITECT_TREE_JOBS.has(run.job),
      )
      .map((run) => run.rootId),
  )
  return runs.map((run) => {
    const scope = scopeFor(run, branch, landingMergedAt, branchChainRoots)
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
