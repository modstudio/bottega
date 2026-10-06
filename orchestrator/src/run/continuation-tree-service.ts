// concern: continuation tree adapter
/** Gathers Git facts for the pure continuation tree decision and renders refusals. */

import { existsSync } from 'node:fs'
import { gitContext } from '../git/git-environment.ts'
import {
  type ContinuationTreeDecision,
  continuationTreeDecision,
} from './continuation-tree-decision.ts'

export function requireContinuationTree(input: {
  rootId: number
  projectName: string | null
  projectPath: string | null
  readsRepo: boolean
  writesRepo: boolean
  recordedTreeMatches: boolean
  recordedWorktree: string | null
  writerTreeRecoverable: boolean
  baseCommit: string | null
}): ContinuationTreeDecision {
  const decision = continuationTreeDecision({
    readsRepo: input.readsRepo,
    writesRepo: input.writesRepo,
    recordedTreePresent: input.writesRepo
      ? input.recordedTreeMatches
      : Boolean(input.recordedWorktree && existsSync(input.recordedWorktree)),
    writerTreeRecoverable: input.writerTreeRecoverable,
    baseCommit: input.baseCommit,
    baseCommitAvailable: Boolean(
      input.baseCommit &&
        input.projectPath &&
        gitContext(input.projectPath, 'rev-parse', '--verify', `${input.baseCommit}^{commit}`),
    ),
  })
  if (decision.action !== 'refuse') return decision
  const detail =
    decision.reason === 'reader-base-missing'
      ? 'its read-only base commit was not recorded'
      : decision.reason === 'reader-base-unavailable'
        ? `its read-only base commit ${input.baseCommit} is unavailable in project ${input.projectName}`
        : 'its writing tree cannot be recreated from a retained tip'
  throw new Error(
    `run ${input.rootId} cannot be continued: ${detail}; dispatch a new run from the registered project checkout`,
  )
}

export function continuationTreeCwd(
  decision: ContinuationTreeDecision,
  recordedCwd: string,
  projectPath: string | null,
): string {
  if (decision.action === 'inherit-present-tree' || decision.action === 'no-tree-required')
    return recordedCwd
  return projectPath!
}

export function continuationReadOnlyBase(decision: ContinuationTreeDecision): string | undefined {
  return decision.action === 'provision-reader-tree' ? decision.baseCommit : undefined
}
