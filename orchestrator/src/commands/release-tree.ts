// concern: cli composition
/** Binds release-at-commit policy to the owned hook-tree lifecycle. */

import { createHookTree, removeHookTreeResult } from '../hook-tree/tree.ts'
import {
  releaseAtCommit,
  type ReleaseAtCommitReport,
  type ReleaseTreeLifecycle,
} from '../release/release-at-commit.ts'

const hookTreeReleaseLifecycle: ReleaseTreeLifecycle = {
  create(projectPath, name, commit) {
    return createHookTree({ cwd: projectPath, name, base: commit })
  },
  remove(path) {
    return removeHookTreeResult(path, 'operator-removal')
  },
}

export function releaseAtCommitFromHookTree(input: {
  project: string
  rung: string
  commit: string
}): Promise<ReleaseAtCommitReport> {
  return releaseAtCommit({ ...input, lifecycle: hookTreeReleaseLifecycle })
}
