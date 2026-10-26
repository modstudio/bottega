// concern: run-call-usage
/** Reduces per-call streamed usage into the turn-level facts persisted on a run. */
import type { StreamEvent } from '../events.ts'

export type RunCallUsage = { modelCalls: number; peakCallTokens: number }

export function foldRunCallUsage(
  summary: RunCallUsage | null,
  event: StreamEvent,
): RunCallUsage | null {
  if (event.kind !== 'usage' || event.per !== 'call') return summary
  return {
    modelCalls: (summary?.modelCalls ?? 0) + 1,
    peakCallTokens: Math.max(summary?.peakCallTokens ?? 0, event.tokens),
  }
}
