// concern: run git guard
import {
  assertSharedRefGuardOutsideWritableRoots,
  prepareSharedRefGuard,
} from '../resources/ref-guard.ts'
import { resolveRefGuardHook } from '../resources/ref-guard-runtime.ts'
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

/** Refuse a worker that could replace either the published hooks or their guard executable. */
export function assertWorkerGitGuardOutsideWritableRoots(
  environment: NonNullable<ReturnType<typeof workerGitConfigEnvironment>>,
  writableRoots: string[],
): void {
  assertSharedRefGuardOutsideWritableRoots(
    environment.GIT_CONFIG_VALUE_0,
    resolveRefGuardHook(),
    writableRoots,
  )
}
