// concern: isolated worker-gate index
/** Presents a run's current tree as staged without changing its real index, HEAD, or branch. */

import { prepareTemporaryGitIndex } from '../git/git-environment.ts'
import { WORKER_GATE_BASE_ENV } from './gate-decision.ts'

export function prepareSyntheticGateIndex(input: {
  worktree: string
  baseCommit: string
  indexPath: string
}): { environment: Record<string, string>; remove(): void } {
  const prepared = prepareTemporaryGitIndex({
    cwd: input.worktree,
    seedTree: input.baseCommit,
    indexPath: input.indexPath,
    stageWorkingTree: true,
  })
  return {
    environment: { ...prepared.environment, [WORKER_GATE_BASE_ENV]: input.baseCommit },
    remove: prepared.remove,
  }
}
