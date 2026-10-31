// concern: live tool-call burst action
import { db, nowIso } from '../database/db.ts'
import { appendRunEvent, type StreamEvent } from '../events.ts'
import { terminateProcessGroup } from '../idle-kill.ts'
import type { TransportHandle } from '../transport/transport.ts'
import type { CheckpointResult } from './checkpoint.ts'
import type { CheckpointSchedule } from './checkpoint-schedule.ts'
import {
  decideToolCallBurst,
  formatToolCallBurstError,
  TOOL_CALL_BURST_WINDOW_MS,
  type ToolCallBurst,
  toolCallBurstAction,
} from './tool-call-burst.ts'

export type ToolBurstState = {
  killed: boolean
  error: string | null
  burst: ToolCallBurst
  termination: Promise<void> | null
}

export function newToolBurstState(): ToolBurstState {
  return {
    killed: false,
    error: null,
    burst: { tripped: false, peakCount: 0, peakAtMs: null },
    termination: null,
  }
}

export async function performToolBurstKill(input: {
  handle: TransportHandle
  cancel: () => void
  checkpoint: CheckpointSchedule<CheckpointResult | null>
  writesJob: boolean
  terminate?: (handle: TransportHandle) => Promise<void>
}): Promise<void> {
  input.cancel()
  if (input.terminate) await input.terminate(input.handle)
  else await terminateProcessGroup(input.handle.pid ?? 0, { direct: input.handle })
  if (input.writesJob) input.checkpoint.request('limit')
}

export function observeToolBurst(input: {
  state: ToolBurstState
  event: StreamEvent
  harness: string
  starts: number[]
  seenToolCallIds: Set<string>
  nowMs?: number
  kill: () => Promise<void>
}): void {
  if (input.event.kind !== 'tool' || input.event.phase === 'update') return
  if (input.event.toolCallId) {
    if (input.seenToolCallIds.has(input.event.toolCallId)) return
    input.seenToolCallIds.add(input.event.toolCallId)
  }
  input.starts.push(input.nowMs ?? Date.now())
  input.state.burst = decideToolCallBurst(input.starts)
  if (!input.state.burst.tripped || input.state.killed) return
  if (toolCallBurstAction(input.harness) !== 'kill') return
  input.state.killed = true
  input.state.error = formatToolCallBurstError(input.state.burst)
  input.state.termination = input.kill()
}

export function recordToolBurstObservation(runId: string, burst: ToolCallBurst): void {
  if (!burst.tripped || burst.peakAtMs === null) return
  const peakAt = new Date(burst.peakAtMs).toISOString()
  const changed = db()
    .query(
      `UPDATE run SET tool_burst_observed_peak=?, tool_burst_observed_at=?
        WHERE record_id=? AND tool_burst_observed_peak IS NULL`,
    )
    .run(burst.peakCount, peakAt, runId)
  if (changed.changes !== 1) return
  appendRunEvent(runId, {
    ts: nowIso(),
    type: 'tool_burst_observed',
    count: burst.peakCount,
    windowMs: TOOL_CALL_BURST_WINDOW_MS,
    peakAt,
  })
}
