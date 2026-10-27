// concern: continuation tree requirement
/** Decides how a repository continuation obtains its tree from recorded facts. */

export type ContinuationTreeDecision =
  | { action: 'no-tree-required' }
  | { action: 'inherit-present-tree' }
  | { action: 'recreate-writer-tree' }
  | { action: 'provision-reader-tree'; baseCommit: string }
  | {
      action: 'refuse'
      reason: 'writer-tree-unrecoverable' | 'reader-base-missing' | 'reader-base-unavailable'
    }

export type RetryLaunchDecision = {
  cwd: string
  base: string | undefined
  launchBase: string | undefined
}

/** Selects the caller checkout and explicit base carried into a fresh retry. */
export function retryLaunchDecision(input: {
  writesRepo: boolean
  inheritedCwd: string
  originalLaunchCwd: string | null
  base: string | undefined
  launchBase: string | undefined
}): RetryLaunchDecision {
  return {
    cwd: input.writesRepo ? input.inheritedCwd : (input.originalLaunchCwd ?? input.inheritedCwd),
    base: input.writesRepo ? input.base : undefined,
    launchBase: input.writesRepo ? input.launchBase : undefined,
  }
}

export function continuationTreeDecision(input: {
  readsRepo: boolean
  writesRepo: boolean
  recordedTreePresent: boolean
  writerTreeRecoverable: boolean
  baseCommit: string | null
  baseCommitAvailable: boolean
}): ContinuationTreeDecision {
  if (!input.readsRepo) return { action: 'no-tree-required' }
  if (input.recordedTreePresent) return { action: 'inherit-present-tree' }
  if (input.writesRepo) {
    return input.writerTreeRecoverable
      ? { action: 'recreate-writer-tree' }
      : { action: 'refuse', reason: 'writer-tree-unrecoverable' }
  }
  if (!input.baseCommit) return { action: 'refuse', reason: 'reader-base-missing' }
  return input.baseCommitAvailable
    ? { action: 'provision-reader-tree', baseCommit: input.baseCommit }
    : { action: 'refuse', reason: 'reader-base-unavailable' }
}
