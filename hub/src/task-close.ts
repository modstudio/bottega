import { pruneTaskBranches, releaseTaskClaims } from './orch.ts'
import { closeTask, type TaskRow, type TaskScope } from './task.ts'

export async function closeThenPrune(
  key: string,
  scope: TaskScope,
  keepBranches: boolean,
  abandonReason: string | undefined,
  dependencies: {
    close?: (key: string, scope: TaskScope, options: { abandonReason?: string }) => Promise<TaskRow>
    prune?: typeof pruneTaskBranches
    releaseClaims?: typeof releaseTaskClaims
  } = {},
) {
  const closed = dependencies.close
    ? await dependencies.close(key, scope, { abandonReason })
    : await closeTask(key, scope, { abandonReason })
  let claimReleaseError: Error | null = null
  try {
    await (dependencies.releaseClaims ?? releaseTaskClaims)(closed.project, closed.key)
  } catch (error) {
    claimReleaseError = error as Error
  }
  if (keepBranches) return { closed, pruned: null, pruneError: null, claimReleaseError }
  try {
    return {
      closed,
      pruned: await (dependencies.prune ?? pruneTaskBranches)(closed.project, closed.key),
      pruneError: null,
      claimReleaseError,
    }
  } catch (error) {
    return { closed, pruned: null, pruneError: error as Error, claimReleaseError }
  }
}
