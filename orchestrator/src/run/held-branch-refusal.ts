// concern: held branch refusal
/** Gathers worktree holders and renders refusals without changing the held tree. */

import { isAbsolute, relative, sep } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal as refusalValue, renderRefusal } from '../../../shared/refusal.ts'
import { db } from '../database/db.ts'
import { realpathOrSpelled, withoutTrailingSeparators } from '../git/checkout-identity.ts'
import { worktreeListPorcelain } from '../git/git-environment.ts'
import { workflowCursorBranchAndWorktree } from '../workflow/workflow-cursor-worktrees.ts'
import { worktreeDirty } from '../worktree/worktree-attribution.ts'
import { decideHeldBranchRemedy, heldBranchRemedyText } from './held-branch-remedy.ts'
import {
  continuationBranchAvailability,
  parseWorktreeList,
  type ResumeTreePlan,
} from './resume-tree.ts'
import type { ClaimTreePlanRuling } from './run-claim-plan.ts'

function canonicalPath(path: string): string {
  return withoutTrailingSeparators(realpathOrSpelled(path))
}

function pathContains(parent: string, child: string): boolean {
  const fromParent = relative(parent, child)
  return (
    fromParent === '' ||
    (fromParent !== '..' && !fromParent.startsWith(`..${sep}`) && !isAbsolute(fromParent))
  )
}

function openCursorNamesTree(path: string): boolean {
  const rows = db()
    .query("SELECT args FROM workflow_cursor WHERE state NOT IN ('done','abandoned')")
    .all() as Array<{ args: string }>
  return rows.some((row) => {
    const worktree = workflowCursorBranchAndWorktree(row.args).worktree
    return worktree !== null && canonicalPath(worktree) === path
  })
}

/** Gather the filesystem and cursor facts needed by the pure held-branch remedy. */
function heldBranchRemedy(path: string, cwd = process.cwd()): string {
  const canonicalTree = canonicalPath(path)
  return heldBranchRemedyText(
    decideHeldBranchRemedy({
      path,
      cwdInsideTree: pathContains(canonicalTree, canonicalPath(cwd)),
      cursorNamesTree: openCursorNamesTree(canonicalTree),
      treeDirty: worktreeDirty(path).dirty,
    }),
  )
}

/** Compose the operator remedy when an architect landing tree owns the reused branch. */
export function taskBranchLandingTreeRefusal(
  refusal: Extract<ClaimTreePlanRuling, { mode: 'refuse' }>,
): string {
  return renderRefusal(
    refusalValue(
      `refusing task branch ${refusal.branch}: it is checked out in architect-owned ${refusal.ownerJob} tree ${refusal.path}.`,
      {
        kind: 'edit',
        text:
          `${heldBranchRemedy(refusal.path)}, ` +
          `or start over from trunk with --base ${refusal.freshBase}`,
      },
    ),
  )
}

export function refuseHeldContinuationBranch(
  id: string,
  projectPath: string | null,
  recordedTreePath: string | null,
  plan: ResumeTreePlan | null,
): void {
  if (!plan || !projectPath) return
  const worktrees = parseWorktreeList(worktreeListPorcelain(projectPath))
  const canonicalWorktrees = worktrees.map((worktree) => ({
    ...worktree,
    path: canonicalPath(worktree.path),
  }))
  const availability = continuationBranchAvailability(
    plan.branch,
    recordedTreePath ? canonicalPath(recordedTreePath) : null,
    canonicalWorktrees,
  )
  if (availability.action === 'continue') return
  const holdingPath =
    worktrees.find(
      (worktree, index) =>
        worktree.branch === plan.branch &&
        canonicalWorktrees[index]?.path === availability.holdingPath,
    )?.path ?? availability.holdingPath
  throw new Error(
    `run ${id} cannot continue: branch ${plan.branch} is checked out at ${holdingPath}\n` +
      `release it with ${heldBranchRemedy(holdingPath)}, then retry ${PLATFORM_SLUG} run continue ${id}`,
  )
}
