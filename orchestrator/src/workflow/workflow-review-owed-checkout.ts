// concern: workflow-review-owed-checkout
/** Selects and resolves the branch under review for workflow floor adapters. */

import type { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { type Project, projectByName } from '../project/projects.ts'
import { gitText } from './workflow-floor-evidence-checkout.ts'

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

export type BranchUnderReviewResolution =
  | { action: 'allow'; project: Project; cwd: string; branch: string; tip: string }
  | {
      action: 'refuse'
      kind: 'project' | 'checkout' | 'tip'
      condition: string
      cwd?: string
      branch?: string
    }

export function resolveBranchUnderReview(
  projectName: string,
  args: Record<string, string>,
  database: Database,
): BranchUnderReviewResolution {
  const project = projectByName(projectName, database)
  if (!project)
    return {
      action: 'refuse',
      kind: 'project',
      condition: `project ${projectName} is not registered`,
    }
  const worktreeArg = args.worktree?.trim() || null
  const worktreeExists = Boolean(worktreeArg && existsSync(worktreeArg))
  const checkout = decideReviewOwedCheckout({
    worktreeArg,
    worktreeExists,
    worktreeHead:
      worktreeArg && worktreeExists
        ? gitText(worktreeArg, ['rev-parse', '--abbrev-ref', 'HEAD'])
        : null,
    branchArg: args.branch?.trim() || null,
    projectPath: project.path,
  })
  if ('refusal' in checkout)
    return { action: 'refuse', kind: 'checkout', condition: checkout.refusal }
  const tip =
    gitText(checkout.cwd, ['rev-parse', '--verify', `${checkout.branch}^{commit}`]) ??
    gitText(checkout.cwd, ['rev-parse', '--verify', `origin/${checkout.branch}^{commit}`])
  if (!tip)
    return {
      action: 'refuse',
      kind: 'tip',
      condition: `cannot resolve the current tip of branch ${checkout.branch}`,
      cwd: checkout.cwd,
      branch: checkout.branch,
    }
  return { action: 'allow', project, ...checkout, tip }
}
