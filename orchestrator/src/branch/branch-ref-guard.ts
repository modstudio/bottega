// concern: branches
/** Guards local branch mutations against case-confusable refs. */

import { db } from '../database/db.ts'
import { git, restoreBranch } from '../git/git-environment.ts'

export type BranchRefDecision =
  | { allowed: true }
  | { allowed: false; reason: 'case-collision'; existing: string }
  | { allowed: false; reason: 'exact-missing' }

/** Decide whether an exact local branch ref may be created or deleted. */
export function decideBranchRefMutation(input: {
  operation: 'create' | 'delete'
  target: string
  localBranches: readonly string[]
}): BranchRefDecision {
  const foldedTarget = input.target.toLowerCase()
  const collision = input.localBranches.find(
    (branch) => branch !== input.target && branch.toLowerCase() === foldedTarget,
  )
  if (collision) return { allowed: false, reason: 'case-collision', existing: collision }
  if (input.operation === 'delete' && !input.localBranches.includes(input.target)) {
    return { allowed: false, reason: 'exact-missing' }
  }
  return { allowed: true }
}

function localBranchNames(repoRoot: string): string[] {
  const output = git(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads'], repoRoot)
  return output.split('\n').filter(Boolean)
}

/** Observe local heads and apply the shared mutation decision. */
export function branchRefMutationDecision(
  repoRoot: string,
  operation: 'create' | 'delete',
  target: string,
): BranchRefDecision {
  return decideBranchRefMutation({ operation, target, localBranches: localBranchNames(repoRoot) })
}

function recordedOwner(branch: string): string | null {
  const row = db()
    .query<{ number: number; status: string; worktree: string | null }, [string, string, string]>(
      `SELECT number,status,worktree
         FROM run
        WHERE branch=? OR minted_branch=? OR branch_kept=?
        ORDER BY CASE WHEN status IN ('running','asking') THEN 0 ELSE 1 END, number DESC
        LIMIT 1`,
    )
    .get(branch, branch, branch)
  if (!row) return null
  return `; recorded by run ${row.number} (${row.status})${row.worktree ? ` at tree ${row.worktree}` : ''}`
}

/** Refuse creation when another local branch differs only by case. */
export function assertBranchRefMayBeCreated(repoRoot: string, branch: string): void {
  const decision = branchRefMutationDecision(repoRoot, 'create', branch)
  if (decision.allowed) return
  if (decision.reason === 'exact-missing') return
  throw new Error(
    `refusing to create branch ${branch}: existing local branch ${decision.existing} differs only by case${recordedOwner(decision.existing)}; use a different branch name`,
  )
}

/** Refuse deletion unless the exact local branch exists without a case-confusable peer. */
export function assertBranchRefMayBeDeleted(repoRoot: string, branch: string): void {
  const decision = branchRefMutationDecision(repoRoot, 'delete', branch)
  if (decision.allowed) return
  if (decision.reason === 'exact-missing') {
    throw new Error(`refusing to delete branch ${branch}: that exact local branch does not exist`)
  }
  throw new Error(
    `refusing to delete branch ${branch}: local branch ${decision.existing} differs only by case; both names must be disambiguated before deletion`,
  )
}

/** Restore one missing branch only after applying the creation guard. */
export function restoreBranchWithCaseGuard(
  repoRoot: string,
  branch: string,
  tip: string,
): { ok: true } | { ok: false; error: string } {
  try {
    assertBranchRefMayBeCreated(repoRoot, branch)
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  return restoreBranch(repoRoot, branch, tip)
}
