// concern: workflow-review-owed-checkout
/** Pure checkout selection for the review-owed floor. Must not know stores or processes. */

export interface ReviewOwedCheckoutFacts {
  worktreeArg: string | null
  worktreeExists: boolean
  worktreeHead: string | null
  branchArg: string | null
  projectPath: string
}

export type ReviewOwedCheckoutDecision = { cwd: string; branch: string } | { refusal: string }

const argumentRemedy = 'pass `--arg branch=<branch>`, or `--arg worktree=<path of a live checkout>`'

export function decideReviewOwedCheckout(
  facts: ReviewOwedCheckoutFacts,
): ReviewOwedCheckoutDecision {
  const worktree = facts.worktreeArg?.trim() || null
  const worktreeHead = facts.worktreeHead?.trim() || null
  const branch = facts.branchArg?.trim() || null

  if (worktree && facts.worktreeExists) {
    if (worktreeHead && worktreeHead !== 'HEAD') return { cwd: worktree, branch: worktreeHead }
    if (branch) return { cwd: worktree, branch }
  } else if (branch) {
    return { cwd: facts.projectPath, branch }
  }

  const absentWorktree = worktree && !facts.worktreeExists ? `; ${worktree} is absent` : ''
  return {
    refusal: `floor review-owed cannot resolve the cursor branch${absentWorktree}; ${argumentRemedy}`,
  }
}
