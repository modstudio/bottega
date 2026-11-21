// concern: close-out tree naming report
/** Carries structured tree namers from removal through cursor-claim cleanup. */

import { pointerMustClear, type ResourceTeardownResult } from './absent-tree-close-out.ts'
import {
  type CursorWorktreeCleanupFailure,
  finishCursorWorktreeClear,
  type prepareCursorWorktreeClear,
} from './close-out-preparation.ts'
import type { CloseOutResult } from './close-out-report.ts'
import { type TreeKeepDecision, treeNamingReleaseReport } from './tree-keep-decision.ts'

export type PreparedTreeNamingResult = CloseOutResult &
  ResourceTeardownResult & {
    preparedTreeNaming?: { baseDetail: string; decision: TreeKeepDecision }
  }

export function appendPreparedTreeNaming(
  result: PreparedTreeNamingResult,
  decision: TreeKeepDecision,
  dryRun: boolean,
  persist?: (result: CloseOutResult) => void,
): void {
  const baseDetail = result.detail
  const report = treeNamingReleaseReport(decision, dryRun ? 'dry-run' : 'named')
  if (report?.detail) result.detail += `; ${report.detail}`
  if (!dryRun && decision.action === 'proceed-named') {
    result.preparedTreeNaming = { baseDetail, decision }
    persist?.(result)
  }
}

function finishPreparedTreeNaming(
  result: PreparedTreeNamingResult,
  cleanup: CursorWorktreeCleanupFailure | null,
  cleared: boolean,
): void {
  const naming = result.preparedTreeNaming
  if (!naming) return
  if (cleanup || cleared) {
    const report = treeNamingReleaseReport(naming.decision, cleanup ? 'not-cleared' : 'cleared')
    result.detail = naming.baseDetail + (report?.detail ? `; ${report.detail}` : '')
    if (report?.clearedCursorClaims.length) result.clearedCursorClaims = report.clearedCursorClaims
    else delete result.clearedCursorClaims
  }
  delete result.preparedTreeNaming
}

export async function completePreparedTreeNaming(
  result: PreparedTreeNamingResult,
  dryRun: boolean,
  clearCursorWorktrees: ReturnType<typeof prepareCursorWorktreeClear>,
  persist: (result: CloseOutResult) => void,
): Promise<CloseOutResult> {
  const shouldClear = Boolean(
    !dryRun &&
      result.worktree &&
      pointerMustClear(result.outcome, result.worktree) &&
      !result.resourceTeardownFailed,
  )
  const cleanup = shouldClear ? await clearCursorWorktrees(result) : null
  finishPreparedTreeNaming(result, cleanup, shouldClear)
  const completed = finishCursorWorktreeClear(result, cleanup)
  if (!dryRun) persist(completed)
  return completed
}
