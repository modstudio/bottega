// concern: live tool-call burst decision
import type { Harness } from '../agent/agent-registry.ts'

export const TOOL_CALL_BURST_WINDOW_MS = 1000
export const TOOL_CALL_BURST_LIMIT = 40

export type ToolCallBurst = {
  tripped: boolean
  peakCount: number
  peakAtMs: number | null
  windowStartsMs: readonly number[]
}

export const EMPTY_TOOL_CALL_BURST: ToolCallBurst = {
  tripped: false,
  peakCount: 0,
  peakAtMs: null,
  windowStartsMs: [],
}

/** Advance the burst decision with one non-decreasing tool-call start time. */
export function decideToolCallBurst(prior: ToolCallBurst, startMs: number): ToolCallBurst {
  const firstLive = prior.windowStartsMs.findIndex(
    (value) => startMs - value <= TOOL_CALL_BURST_WINDOW_MS,
  )
  const retained = firstLive < 0 ? [] : prior.windowStartsMs.slice(firstLive)
  const windowStartsMs = [...retained, startMs]
  const peakCount = Math.max(prior.peakCount, windowStartsMs.length)
  return {
    tripped: peakCount > TOOL_CALL_BURST_LIMIT,
    peakCount,
    peakAtMs: peakCount > prior.peakCount ? startMs : prior.peakAtMs,
    windowStartsMs,
  }
}

export function toolCallBurstAction(harness: Harness | null): 'kill' | 'observe' {
  return harness === 'goose' ? 'kill' : 'observe'
}

export function formatToolCallBurstError(burst: ToolCallBurst): string {
  return (
    `tool-call burst: ${burst.peakCount} starts in ${TOOL_CALL_BURST_WINDOW_MS}ms; ` +
    `TOOL_CALL_BURST_LIMIT=${TOOL_CALL_BURST_LIMIT}, ` +
    `TOOL_CALL_BURST_WINDOW_MS=${TOOL_CALL_BURST_WINDOW_MS}`
  )
}
