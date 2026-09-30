// concern: close-out report
import type { KeepTreeHoldDecision } from '../worktree/keep-tree-hold.ts'

export type ConversationKeepTreeHold =
  | (KeepTreeHoldDecision & { reason?: string })
  | { held: true; until: null; reason: string }
  | { held: false; kept: true; reason: string }

/** Separates the clean landing tree's report word from its persisted outcome. */
export function cleanLandingTreeCloseOutResult(runId: number, worktree: string, detail: string) {
  return { runId, worktree, outcome: 'held' as const, reportOutcome: 'kept' as const, detail }
}
