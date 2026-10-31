// concern: live tool-call burst decision

export const TOOL_CALL_BURST_WINDOW_MS = 1000
export const TOOL_CALL_BURST_LIMIT = 40

export type ToolCallBurst = {
  tripped: boolean
  peakCount: number
  peakAtMs: number | null
}

/** Decide the maximum count in any closed sliding window of tool-call starts. */
export function decideToolCallBurst(startTimesMs: readonly number[]): ToolCallBurst {
  const ordered = [...startTimesMs].sort((a, b) => a - b)
  let left = 0
  let peakCount = 0
  let peakAtMs: number | null = null
  for (let right = 0; right < ordered.length; right++) {
    while (ordered[right]! - ordered[left]! > TOOL_CALL_BURST_WINDOW_MS) left++
    const count = right - left + 1
    if (count > peakCount) {
      peakCount = count
      peakAtMs = ordered[right]!
    }
  }
  return { tripped: peakCount > TOOL_CALL_BURST_LIMIT, peakCount, peakAtMs }
}

export function toolCallBurstAction(harness: string): 'kill' | 'observe' {
  return harness === 'goose' ? 'kill' : 'observe'
}

export function formatToolCallBurstError(burst: ToolCallBurst): string {
  return (
    `tool-call burst: ${burst.peakCount} starts in ${TOOL_CALL_BURST_WINDOW_MS}ms; ` +
    `TOOL_CALL_BURST_LIMIT=${TOOL_CALL_BURST_LIMIT}, ` +
    `TOOL_CALL_BURST_WINDOW_MS=${TOOL_CALL_BURST_WINDOW_MS}`
  )
}
