// concern: run-resume-claim
/** Prepares and restores a retained conversation branch during tree creation. */

import { git, gitContext } from '../git/git-environment.ts'
import { removeFor } from '../worktree/worktree-remove.ts'
import type { Worktree } from '../worktree/worktree-types.ts'
import type { ResumeTreePlan } from './resume-tree.ts'

type RecreateResumeTreePlan = Extract<
  ResumeTreePlan,
  { action: 'recreate-on-branch' | 'recreate-then-restore' }
>

export function prepareResumeBranchIfNeeded(
  repoRoot: string,
  plan: RecreateResumeTreePlan | undefined,
): void {
  if (plan?.action !== 'recreate-on-branch') return
  const current = gitContext(
    repoRoot,
    'rev-parse',
    '--verify',
    `refs/heads/${plan.branch}^{commit}`,
  )
  if (!current) git(['update-ref', `refs/heads/${plan.branch}`, plan.tip], repoRoot)
}

export function restoreResumeIfNeeded(
  created: Worktree,
  plan: RecreateResumeTreePlan | undefined,
  runId: number,
): Worktree {
  if (!plan) return created
  if (plan.action === 'recreate-then-restore') {
    try {
      git(['reset', '--hard', plan.tip], created.path)
    } catch {
      // The postcondition below gives one failure shape for refusal and a wrong resulting tip.
    }
  }
  const actual = gitContext(created.path, 'rev-parse', '--verify', 'HEAD^{commit}')
  if (actual !== plan.tip) {
    const cleanup = removeFor(created, created.repoRoot, false, true, runId)
    throw new Error(
      `resumed tree postcondition failed: expected ${plan.tip}, got ${actual ?? '(unresolved)'}; ` +
        `cleanup: ${cleanup.removed ? 'removed tree and kept every branch' : cleanup.detail}`,
    )
  }
  return { ...created, base: plan.tip }
}
