// concern: branches
/** Guards local branch mutations against case-confusable refs. */

import { db } from '../database/db.ts'
import { git, targetGitEnvironment } from '../git/git-environment.ts'

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

type LocalBranchRef = { name: string; tip: string }

function localBranchRefs(repoRoot: string): LocalBranchRef[] {
  const output = git(
    ['for-each-ref', '--format=%(refname:strip=2)%09%(objectname)', 'refs/heads'],
    repoRoot,
  )
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, tip] = line.split('\t')
      if (!name || !tip) throw new Error(`invalid local branch observation: ${line}`)
      return { name, tip }
    })
}

export type BranchRefObservation = { decision: BranchRefDecision; exactTip: string | null }

/** Observe all local heads once, preserving exact spelling and its classified tip. */
export function observeBranchRefMutation(
  repoRoot: string,
  operation: 'create' | 'delete',
  target: string,
): BranchRefObservation {
  const refs = localBranchRefs(repoRoot)
  return {
    decision: decideBranchRefMutation({
      operation,
      target,
      localBranches: refs.map((ref) => ref.name),
    }),
    exactTip: refs.find((ref) => ref.name === target)?.tip ?? null,
  }
}

/** Observe local heads and apply the shared mutation decision. */
function branchRefMutationDecision(
  repoRoot: string,
  operation: 'create' | 'delete',
  target: string,
): BranchRefDecision {
  return observeBranchRefMutation(repoRoot, operation, target).decision
}

function recordedOwner(repoRoot: string, branch: string): string | null {
  const row = db()
    .query<
      { number: number; status: string; worktree: string | null },
      [string, string, string, string]
    >(
      `SELECT number,status,worktree
         FROM run
        WHERE (branch=? OR minted_branch=? OR branch_kept=?)
          AND project_record_id=(SELECT record_id FROM project WHERE path=?)
        ORDER BY CASE WHEN status IN ('running','asking') THEN 0 ELSE 1 END, number DESC
        LIMIT 1`,
    )
    .get(branch, branch, branch, repoRoot)
  if (!row) return null
  return `; recorded by run ${row.number} (${row.status})${row.worktree ? ` at tree ${row.worktree}` : ''}`
}

/** Refuse creation when another local branch differs only by case. */
export function assertBranchRefMayBeCreated(repoRoot: string, branch: string): void {
  const decision = branchRefMutationDecision(repoRoot, 'create', branch)
  if (decision.allowed) return
  if (decision.reason === 'exact-missing') return
  throw new Error(
    `refusing to create branch ${branch}: existing local branch ${decision.existing} differs only by case${recordedOwner(repoRoot, decision.existing)}; use a different branch name`,
  )
}

/** Refuse deletion unless the exact local branch exists without a case-confusable peer. */
export function assertBranchRefDecisionMayBeDeleted(
  decision: BranchRefDecision,
  branch: string,
): void {
  if (decision.allowed) return
  if (decision.reason === 'exact-missing') {
    throw new Error(`refusing to delete branch ${branch}: that exact local branch does not exist`)
  }
  throw new Error(
    `refusing to delete branch ${branch}: local branch ${decision.existing} differs only by case; both names must be disambiguated before deletion`,
  )
}

/** Refuse deletion unless the exact local branch exists without a case-confusable peer. */
export function assertBranchRefMayBeDeleted(repoRoot: string, branch: string): void {
  assertBranchRefDecisionMayBeDeleted(branchRefMutationDecision(repoRoot, 'delete', branch), branch)
}

/** Read a local branch tip only when that exact spelling occurs in the heads listing. */
export function exactBranchTip(repoRoot: string, branch: string): string | null {
  return observeBranchRefMutation(repoRoot, 'delete', branch).exactTip
}

/** Restore one missing branch only after applying the creation guard. */
export function restoreBranch(
  repoRoot: string,
  branch: string,
  tip: string,
): { ok: true } | { ok: false; error: string } {
  try {
    const observation = observeBranchRefMutation(repoRoot, 'create', branch)
    if (!observation.decision.allowed && observation.decision.reason === 'case-collision') {
      throw new Error(
        `refusing to create branch ${branch}: existing local branch ${observation.decision.existing} differs only by case${recordedOwner(repoRoot, observation.decision.existing)}; use a different branch name`,
      )
    }
    if (observation.exactTip === tip) return { ok: true }
    if (observation.exactTip !== null) {
      return { ok: false, error: `branch already exists at ${observation.exactTip}` }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  const ref = `refs/heads/${branch}`
  const zero = '0000000000000000000000000000000000000000'
  // branch-ref-guard: observeBranchRefMutation
  const result = Bun.spawnSync(['git', 'update-ref', ref, tip, zero], {
    cwd: repoRoot,
    env: targetGitEnvironment(repoRoot),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return result.exitCode === 0
    ? { ok: true }
    : { ok: false, error: result.stderr.toString().trim() || `exit ${result.exitCode}` }
}
