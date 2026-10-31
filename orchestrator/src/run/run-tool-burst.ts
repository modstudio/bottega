// concern: live tool-call burst action
import { type Harness, harnessIdentity } from '../agent/agent-registry.ts'
import { db, nowIso } from '../database/db.ts'
import { appendRunEvent, isToolCallStart, type StreamEvent } from '../events.ts'
import type { classify } from '../failure/failure.ts'
import { type TerminateResult, terminateProcessGroup } from '../idle-kill.ts'
import type { OutcomeStatus } from '../outcome.ts'
import type { TransportHandle, TransportResult } from '../transport/transport.ts'
import type { CheckpointResult } from './checkpoint.ts'
import type { CheckpointSchedule } from './checkpoint-schedule.ts'
import { unkillableKillResult } from './run-idle-kill.ts'
import {
  decideToolCallBurst,
  EMPTY_TOOL_CALL_BURST,
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
  terminateResult: TerminateResult | null
  seenToolCallIds: Set<string>
}

export function newToolBurstState(): ToolBurstState {
  return {
    killed: false,
    error: null,
    burst: EMPTY_TOOL_CALL_BURST,
    termination: null,
    terminateResult: null,
    seenToolCallIds: new Set<string>(),
  }
}

export async function performToolBurstKill(input: {
  state: ToolBurstState
  handle: TransportHandle
  cancel: () => void
  checkpoint: CheckpointSchedule<CheckpointResult | null>
  writesJob: boolean
  forceCollect: (result: TransportResult) => void
  terminate?: (handle: TransportHandle) => Promise<TerminateResult>
}): Promise<void> {
  input.cancel()
  const terminated = input.terminate
    ? await input.terminate(input.handle)
    : await terminateProcessGroup(input.handle.pid ?? 0, { direct: input.handle })
  input.state.terminateResult = terminated
  if (terminated.unkillable) {
    input.state.error = `${input.state.error}; ${terminated.reason}`
    input.forceCollect(unkillableKillResult(input.state.error, input.handle.pid ?? 0, 'tool_burst'))
  }
  if (input.writesJob) input.checkpoint.request('limit')
}

export function observeToolBurst(input: {
  state: ToolBurstState
  event: StreamEvent
  harness: Harness | null
  nowMs?: number
  kill: () => Promise<void>
}): void {
  if (input.event.kind !== 'tool' || !isToolCallStart(input.event)) return
  if (input.state.killed) return
  if (input.event.toolCallId) {
    if (input.state.seenToolCallIds.has(input.event.toolCallId)) return
    input.state.seenToolCallIds.add(input.event.toolCallId)
  }
  input.state.burst = decideToolCallBurst(input.state.burst, input.nowMs ?? Date.now())
  if (!input.state.burst.tripped) return
  if (toolCallBurstAction(input.harness) !== 'kill') return
  input.state.killed = true
  input.state.error = formatToolCallBurstError(input.state.burst)
  input.state.termination = input.kill()
}

export function toolBurstObserver(input: {
  toolBurst: ToolBurstState
  harness: string | undefined
  handle: TransportHandle
  cancel: () => void
  checkpoint: CheckpointSchedule<CheckpointResult | null>
  writesJob: boolean
  forceCollect: (result: TransportResult) => void
}): (event: StreamEvent) => void {
  return (event) =>
    observeToolBurst({
      state: input.toolBurst,
      event,
      harness: harnessIdentity(input.harness),
      kill: () =>
        performToolBurstKill({
          state: input.toolBurst,
          handle: input.handle,
          cancel: input.cancel,
          checkpoint: input.checkpoint,
          writesJob: input.writesJob,
          forceCollect: input.forceCollect,
        }),
    })
}

export function recordToolBurstObservation(runId: string, burst: ToolCallBurst): void {
  if (!burst.tripped || burst.peakAtMs === null) return
  try {
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
  } catch (error) {
    console.error(`orch: run ${runId} tool-burst observation write failed: ${error}`)
  }
}

/** Wait for a burst kill to finish, then record a burst the harness only observes. */
export async function settleToolBurst(
  runId: string,
  harness: string | undefined,
  state: ToolBurstState,
): Promise<void> {
  if (state.termination) await state.termination
  if (toolCallBurstAction(harnessIdentity(harness)) === 'observe')
    recordToolBurstObservation(runId, state.burst)
}

export function applyToolBurstOutcome(
  state: Pick<ToolBurstState, 'killed' | 'error'>,
  outcome: {
    status: OutcomeStatus
    failureKind: ReturnType<typeof classify> | null
    error: string | null
  },
): typeof outcome {
  return state.killed
    ? { status: 'failed', failureKind: 'tool_burst', error: state.error }
    : outcome
}

export function toolBurstStopsWall(state: ToolBurstState): boolean {
  return state.killed && !state.terminateResult?.unkillable
}
