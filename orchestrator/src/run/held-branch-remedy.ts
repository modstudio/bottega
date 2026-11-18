// concern: held-branch remedy
/** Decides and renders the operator remedy for a branch held by another tree. */

import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { taskBranchLandingTreeRefusal } from '../branch/task-branch.ts'
import { db } from '../database/db.ts'
import { realpathOrSpelled } from '../git/checkout-identity.ts'
import type { ClaimTreePlanRuling } from './run-claim-plan.ts'

export type HeldBranchRemedyFacts = {
  path: string
  liveRunId: string | null
}

export type HeldBranchRemedy = { action: 'wait-or-stop'; runId: string } | { action: 'detach' }

type LiveTreeRunRow = {
  record_id: string
  worktree: string
}

/** A live run keeps authority over its recorded tree; an idle tree can detach safely. */
export function decideHeldBranchRemedy(facts: HeldBranchRemedyFacts): HeldBranchRemedy {
  return facts.liveRunId ? { action: 'wait-or-stop', runId: facts.liveRunId } : { action: 'detach' }
}

/** Render a decision as an operator action that clears the branch hold. */
export function renderHeldBranchRemedy(path: string, remedy: HeldBranchRemedy): string {
  if (remedy.action === 'wait-or-stop') {
    return (
      `run ${remedy.runId} is live on ${path}; wait with ${PLATFORM_SLUG} run wait ${remedy.runId} ` +
      `or stop it with ${PLATFORM_SLUG} run stop ${remedy.runId}`
    )
  }
  return `git -C ${path} switch --detach; this keeps uncommitted changes`
}

/** Gather the local run-table fact, decide, and render the release for one held tree. */
export function heldBranchRemedy(path: string): string {
  const canonicalPath = realpathOrSpelled(path)
  const liveRun = (
    db()
      .query(
        `SELECT record_id,worktree
           FROM run
          WHERE status IN ('running','asking') AND worktree IS NOT NULL
          ORDER BY number DESC`,
      )
      .all() as LiveTreeRunRow[]
  ).find((row) => realpathOrSpelled(row.worktree) === canonicalPath)
  return renderHeldBranchRemedy(
    path,
    decideHeldBranchRemedy({ path, liveRunId: liveRun?.record_id ?? null }),
  )
}

/** Compose the architect-tree refusal identically at dispatch and claim time. */
export function heldLandingTreeRefusal(
  refusal: Extract<ClaimTreePlanRuling, { mode: 'refuse' }>,
): string {
  return taskBranchLandingTreeRefusal(refusal, heldBranchRemedy(refusal.path))
}
