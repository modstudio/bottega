// concern: close-out release holds
/** Rechecks landing ownership and pins retained refs immediately before tree release. */
import { existsSync } from 'node:fs'
import { db } from '../database/db.ts'
import { targetGitEnvironment } from '../git/git-environment.ts'
import { observeLandingTreeRelease } from '../landing-tree/release-observation.ts'
import { projectAt } from '../project/projects.ts'
import { LANDING_TREE_JOB } from '../run/synthetic-lifecycle-job.ts'

type ReleaseHoldResult = {
  runId: number
  worktree: string
  outcome: 'held' | 'failed'
  detail: string
}

export function landingTreeReleaseHold(input: {
  runId: number
  job: string
  repo: string | null
  worktree: string
  branch: string | null
  sessionId: string | null
  launchKey: string | null
  status: string
}): ReleaseHoldResult | null {
  if (input.job !== LANDING_TREE_JOB) return null
  const project = input.repo ?? projectAt(input.worktree)?.name ?? null
  const treeExists = existsSync(input.worktree)
  if (!treeExists && (!project || !input.branch)) return null
  const landingInFlight = Boolean(
    project &&
      input.branch &&
      db()
        .query(
          `SELECT 1 FROM landing
           WHERE project=? AND branch=? AND status IN ('queued','running') LIMIT 1`,
        )
        .get(project, input.branch),
  )
  const decision = observeLandingTreeRelease({ ...input, treeExists, landingInFlight })
  return decision.action === 'keep'
    ? { runId: input.runId, worktree: input.worktree, outcome: 'held', detail: decision.reason }
    : null
}

export function protectRetainedBranch(input: {
  repoRoot: string
  retainedRef: string | null
  branchSnapshot: string | null
  retainedBranch: string | null
  runId: number
  treePath: string
}): ReleaseHoldResult | null {
  if (!input.retainedRef || !input.branchSnapshot) return null
  const pinned = Bun.spawnSync(['git', 'update-ref', input.retainedRef, input.branchSnapshot], {
    cwd: input.repoRoot,
    env: targetGitEnvironment(input.repoRoot),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return pinned.exitCode === 0
    ? null
    : {
        runId: input.runId,
        worktree: input.treePath,
        outcome: 'failed',
        detail:
          `could not protect retained branch ${input.retainedBranch} at ${input.branchSnapshot}: ` +
          (pinned.stderr.toString().trim() || `git update-ref exited ${pinned.exitCode}`),
      }
}
