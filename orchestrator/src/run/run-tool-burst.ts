// concern: live tool-call burst action
import type { Harness } from '../agent/agent-registry.ts'
import { db, nowIso } from '../database/db.ts'
import { appendRunEvent, isToolCallStart, type StreamEvent } from '../events.ts'
import type { classify } from '../failure/failure.ts'
import { type TerminateResult, terminateProcessGroup } from '../idle-kill.ts'
import type { OutcomeStatus } from '../outcome.ts'
import {
  EMPTY_VENDOR_USAGE,
  type TransportHandle,
  type TransportResult,
} from '../transport/transport.ts'
import type { CheckpointResult } from './checkpoint.ts'
import type { CheckpointSchedule } from './checkpoint-schedule.ts'
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
    input.forceCollect(unkillableToolBurstResult(input.state.error, input.handle.pid ?? 0))
  }
  if (input.writesJob) input.checkpoint.request('limit')
}

/** A collected-as-failed result for a tool-burst tree that survived SIGKILL. */
function unkillableToolBurstResult(error: string, pid: number): TransportResult {
  return {
    stdout: '',
    stderr: error,
    raw: '',
    parsed: null,
    output: '',
    tokens: null,
    costUsd: null,
    vendorUsage: EMPTY_VENDOR_USAGE,
    sessionId: null,
    stopReason: 'timeout',
    error,
    exitCode: -1,
    pid,
    events: [],
    asking: false,
    failureKind: 'tool_burst',
    status: 'failed',
    questions: [],
  }
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
  if (!input.state.burst.tripped || input.state.killed) return
  if (toolCallBurstAction(input.harness) !== 'kill') return
  input.state.killed = true
  input.state.error = formatToolCallBurstError(input.state.burst)
  input.state.termination = input.kill()
}

export function toolBurstObserver(input: {
  state: ToolBurstState
  harness: Harness | null
  handle: TransportHandle
  cancel: () => void
  checkpoint: CheckpointSchedule<CheckpointResult | null>
  writesJob: boolean
  forceCollect: (result: TransportResult) => void
}): (event: StreamEvent) => void {
  return (event) =>
    observeToolBurst({
      state: input.state,
      event,
      harness: input.harness,
      kill: () =>
        performToolBurstKill({
          state: input.state,
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

export function recordObservedToolBurst(
  runId: string,
  harness: Harness | null,
  state: ToolBurstState,
): void {
  if (toolCallBurstAction(harness) === 'observe') recordToolBurstObservation(runId, state.burst)
}

export async function settleToolBurst(state: ToolBurstState): Promise<void> {
  if (state.termination) await state.termination
}

export function applyToolBurstOutcome(
  killed: boolean,
  burstError: string | null,
  outcome: {
    status: OutcomeStatus
    failureKind: ReturnType<typeof classify> | null
    error: string | null
  },
): typeof outcome {
  return killed ? { status: 'failed', failureKind: 'tool_burst', error: burstError } : outcome
}

export function toolBurstStopsWall(state: ToolBurstState): boolean {
  return state.killed && !state.terminateResult?.unkillable
}

export function toolBurstTerminationResult(state: ToolBurstState): {
  toolBurstUnkillable: boolean
  toolBurstTreePids: number[]
  toolBurstTreePgid: number | null
} {
  return {
    toolBurstUnkillable: state.terminateResult?.unkillable ?? false,
    toolBurstTreePids: state.terminateResult?.pids ?? [],
    toolBurstTreePgid: state.terminateResult?.pgid ?? null,
  }
}
