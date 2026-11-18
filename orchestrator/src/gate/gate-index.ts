// concern: isolated worker-gate index
/** Presents a run's current tree as staged without changing its real index, HEAD, or branch. */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareTemporaryGitIndex } from '../git/git-environment.ts'
import { WORKER_GATE_BASE_ENV } from './gate-decision.ts'

export function prepareSyntheticGateIndex(input: { worktree: string; baseCommit: string }): {
  environment: Record<string, string>
  treeId: string
  remove(): void
} {
  const directory = mkdtempSync(join(tmpdir(), 'orch-worker-gate-index-'))
  let prepared: ReturnType<typeof prepareTemporaryGitIndex>
  try {
    prepared = prepareTemporaryGitIndex({
      cwd: input.worktree,
      seedTree: input.baseCommit,
      indexPath: join(directory, 'index'),
      stageWorkingTree: true,
    })
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
  return {
    environment: { ...prepared.environment, [WORKER_GATE_BASE_ENV]: input.baseCommit },
    treeId: prepared.git(['write-tree']),
    remove: () => {
      try {
        prepared.remove()
      } finally {
        rmSync(directory, { recursive: true, force: true })
      }
    },
  }
}

/** Snapshot a working tree through the same disposable-index path used by worker gates. */
export function architectGateTree(worktree: string): string {
  const prepared = prepareSyntheticGateIndex({ worktree, baseCommit: 'HEAD' })
  try {
    return prepared.treeId
  } finally {
    prepared.remove()
  }
}
