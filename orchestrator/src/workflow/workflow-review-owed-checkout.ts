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

export const reviewOwedArgumentRemedy =
  'pass `--arg worktree=<path>` naming a live checkout on the branch under review, or pass `--arg branch=<branch>` when no live worktree is named'

function describeWorktreeCondition(
  worktree: string | null,
  worktreeExists: boolean,
  worktreeHead: string | null,
): string {
  if (worktree && !worktreeExists) return `; ${worktree} is absent`
  if (worktree && !worktreeHead) return `; ${worktree} exists but its HEAD could not be read`
  if (worktree && worktreeHead === 'HEAD') return `; ${worktree} is on a detached HEAD`
  return ''
}

export function decideReviewOwedCheckout(
  facts: ReviewOwedCheckoutFacts,
): ReviewOwedCheckoutDecision {
  const worktree = facts.worktreeArg?.trim() || null
  const worktreeHead = facts.worktreeHead?.trim() || null
  const branch = facts.branchArg?.trim() || null

  if (worktree && facts.worktreeExists) {
    if (worktreeHead && worktreeHead !== 'HEAD') return { cwd: worktree, branch: worktreeHead }
    if (worktreeHead === 'HEAD' && branch) return { cwd: worktree, branch }
    if (!worktreeHead && branch) return { cwd: facts.projectPath, branch }
  } else if (branch) {
    return { cwd: facts.projectPath, branch }
  }

  const worktreeCondition = describeWorktreeCondition(worktree, facts.worktreeExists, worktreeHead)
  return {
    refusal: `floor review-owed cannot resolve the cursor branch${worktreeCondition}; ${reviewOwedArgumentRemedy}`,
  }
}
