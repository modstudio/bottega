// concern: close-out report
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { LandingTreeHoldKind } from '../landing-tree/landing-tree.ts'
import type { KeepTreeHoldDecision } from '../worktree/keep-tree-hold.ts'

export type ConversationKeepTreeHold =
  | (KeepTreeHoldDecision & { reason?: string; hold?: LandingTreeHoldKind })
  | { held: true; until: null; reason: string; hold?: LandingTreeHoldKind }
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
  hold?: LandingTreeHoldKind
  inFlightRef?: string | null
  suppressBlock?: boolean
}

export type HeldTreeJson = {
  runId: string
  worktree: string
  hold: LandingTreeHoldKind
  inFlightRef: string | null
  suppressBlock: boolean
}

export function heldConversationCloseOutResult(
  runId: string,
  worktree: string,
  hold: Extract<ConversationKeepTreeHold, { held: true }>,
): CloseOutReportResult {
  return {
    runId,
    worktree,
    outcome: 'held',
    detail:
      hold.until === null
        ? hold.reason
        : `held by ${hold.reason} until ${hold.until}; clear with ${PLATFORM_SLUG} run discard ${runId}`,
    hold: hold.hold,
  }
}

export function formatCloseOutReport(result: CloseOutReportResult): string {
  const reportOutcome = result.reportOutcome ?? result.outcome
  return `${reportOutcome} run ${result.runId}${result.worktree ? ` ${result.worktree}` : ''}: ${result.detail}`
}

export function heldTreeJson(result: CloseOutReportResult): HeldTreeJson | null {
  if ((result.reportOutcome ?? result.outcome) !== 'held' || !result.worktree) return null
  return {
    runId: result.runId,
    worktree: result.worktree,
    hold: result.hold ?? 'other',
    inFlightRef: result.inFlightRef ?? null,
    suppressBlock: result.suppressBlock ?? false,
  }
}

export function closeOutJson(result: CloseOutReportResult): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    runId: result.runId,
    worktree: result.worktree,
    outcome: result.reportOutcome ?? result.outcome,
    detail: result.detail,
  }
  const held = heldTreeJson(result)
  if (held) Object.assign(payload, held)
  return payload
}

export function heldTreeFromError(cause: unknown): HeldTreeJson | null {
  if (!(cause instanceof Error) || !('heldTree' in cause)) return null
  return (cause as Error & { heldTree: HeldTreeJson }).heldTree
}

export function annotateHeldTreeDetail(
  detail: string,
  inFlight: { ref: string; suppressBlock: boolean } | null,
): string {
  if (!inFlight) return detail
  const clause = `in flight (${inFlight.ref})`
  return inFlight.suppressBlock ? `${clause}; ${detail}` : `${detail}; ${clause}`
}
