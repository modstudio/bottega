// concern: close-out report
import type { KeepTreeHoldDecision } from '../worktree/keep-tree-hold.ts'

export type ConversationKeepTreeHold =
  | (KeepTreeHoldDecision & { reason?: string })
  | { held: true; until: null; reason: string }
  | { held: false; kept: true; reason: string }

/** Separates the clean landing tree's report word from its persisted outcome. */
export function cleanLandingTreeCloseOutResult(runId: string, worktree: string, detail: string) {
  return { runId, worktree, outcome: 'held' as const, reportOutcome: 'kept' as const, detail }
}

export type CloseOutReportResult = {
  runId: string
  worktree: string | null
  outcome: string
  reportOutcome?: string
  detail: string
}

export function formatCloseOutReport(result: CloseOutReportResult): string {
  const reportOutcome = result.reportOutcome ?? result.outcome
  return `${reportOutcome} run ${result.runId}${result.worktree ? ` ${result.worktree}` : ''}: ${result.detail}`
}

/** The hold itself is the in-flight landing, not unique work or another reason. */
export function closeOutHoldIsInFlightLanding(detail: string): boolean {
  return detail.includes('landing is in flight') || detail.includes('branch has not landed')
}

export function annotateHeldTreeDetail(
  detail: string,
  inFlight: { ref: string; suppressBlock: boolean } | null,
): string {
  if (!inFlight) return detail
  const clause = `in flight (${inFlight.ref})`
  return inFlight.suppressBlock ? `${clause}; ${detail}` : `${detail}; ${clause}`
}
