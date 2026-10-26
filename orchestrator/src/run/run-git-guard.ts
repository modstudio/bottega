// concern: run git guard
import { statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { worktreeGitDir } from '../git/git-environment.ts'
import {
  assertSharedRefGuardOutsideWritableRoots,
  ensureWorkerBranchNamespaceDirs,
  prepareSharedRefGuard,
  workerSharedGitRoots,
} from '../resources/ref-guard.ts'
import { resolveRefGuardHook } from '../resources/ref-guard-runtime.ts'
import type { Worktree } from '../worktree/worktree-types.ts'

/** Shared git roots for a writing worktree, creating the branch namespace dirs if missing. */
export function provisionWriterSharedGitRoots(
  worktree: Worktree | null,
  writesRepo: boolean,
): string[] {
  if (!worktree || !writesRepo) return []
  ensureWorkerBranchNamespaceDirs(worktree.path, worktree.branch)
  const roots = [
    worktreeGitDir(worktree.path),
    ...workerSharedGitRoots(worktree.path, worktree.branch),
  ]
  const agentsPath = join(worktree.path, '.agents')
  if (statSync(agentsPath, { throwIfNoEntry: false })?.isDirectory()) roots.push(agentsPath)
  return roots
}

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
function assertWorkerGitGuardOutsideWritableRoots(
  environment: NonNullable<ReturnType<typeof workerGitConfigEnvironment>>,
  writableRoots: string[],
): void {
  assertSharedRefGuardOutsideWritableRoots(
    environment.GIT_CONFIG_VALUE_0,
    resolveRefGuardHook(),
    writableRoots,
  )
}

export function assertConfiguredGitGuard(
  environment: ReturnType<typeof workerGitConfigEnvironment>,
  writableRoots: string[],
): void {
  if (environment) assertWorkerGitGuardOutsideWritableRoots(environment, writableRoots)
}

export const HARNESS_RUN_MARKER = `${PLATFORM_SLUG}-harness-run`

/** Mark one harness run's worktree metadata for the tracked pre-push hook. */
export function installHarnessPushGuard(worktree: Worktree | null, recordId: string): void {
  if (!worktree) return
  writeFileSync(join(worktreeGitDir(worktree.path), HARNESS_RUN_MARKER), `${recordId}\n`)
}
