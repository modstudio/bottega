// concern: run-task-branch-resolution
/** Resolves a supplied or register-backed task branch for a claimed run. */

import type { TaskBranchCandidate } from '../branch/task-branch.ts'
import { resolveCompatibleTaskBranch } from '../branch/task-branch-reuse.ts'

export function taskBranchResolution(
  supplied: TaskBranchCandidate | null | undefined,
  callerCwd: string,
  key: string,
): TaskBranchCandidate | null {
  return supplied !== undefined ? supplied : resolveCompatibleTaskBranch(callerCwd, key)
}
