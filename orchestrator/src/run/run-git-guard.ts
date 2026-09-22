// concern: run git guard
import { prepareSharedRefGuard } from '../resources/ref-guard.ts'
import type { Worktree } from '../worktree/worktree-types.ts'

/** Give writers their shared-ref guard and readers an unconditional push refusal. */
export function workerGitConfigEnvironment(
  worktree: Worktree | null,
  writesJob: boolean,
  jobName: string | undefined,
): ReturnType<typeof prepareSharedRefGuard> | undefined {
  if (!worktree) return undefined
  return writesJob
    ? prepareSharedRefGuard(
        worktree.path,
        jobName !== 'land' ? `refs/heads/${worktree.branch}` : undefined,
      )
    : prepareSharedRefGuard(worktree.path, undefined, worktree.repoRoot)
}
