// concern: run git guard
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitContext, worktreeGitDir } from '../git/git-environment.ts'
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
  return [worktreeGitDir(worktree.path), ...workerSharedGitRoots(worktree.path, worktree.branch)]
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

/** Install an unconditional push refusal in one harness run's worktree metadata. */
export function installHarnessPushGuard(worktree: Worktree | null): void {
  if (!worktree) return
  const hooks = join(worktreeGitDir(worktree.path), 'harness-hooks')
  mkdirSync(hooks, { recursive: true })
  const hook = join(hooks, 'pre-push')
  writeFileSync(
    hook,
    '#!/bin/sh\necho "push refused: this worktree belongs to a harness run" >&2\nexit 1\n',
  )
  chmodSync(hook, 0o755)
  gitContext(worktree.path, 'config', 'extensions.worktreeConfig', 'true')
  gitContext(worktree.path, 'config', '--worktree', 'core.hooksPath', hooks)
}
