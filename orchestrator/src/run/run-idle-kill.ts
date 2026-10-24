// concern: live idle kill
/**
 * The action half of the live idle detector.
 *
 * It reads the run's own facts (last event, asking, open question), observes
 * the vendor process tree, and, once the pure decision in `../idle-kill.ts`
 * says the vendor is idle, takes a preservation checkpoint and terminates the
 * tree. The checkpoint schedule it requests is built by the caller from
 * `./checkpoint-schedule.ts`.
 */
import { db, nowIso } from '../database/db.ts'
import { appendRunEvent } from '../events.ts'
import {
  formatIdleKillError,
  idleKillMayProceed,
  shouldIdleKill,
  terminateProcessGroup,
} from '../idle-kill.ts'
import { jobIdleKillMs } from '../jobs/jobs.ts'
import type { ProcessSample } from '../process-resource-sampler.ts'
import {
  EMPTY_VENDOR_USAGE,
  type TransportHandle,
  type TransportResult,
} from '../transport/transport.ts'
import {
  type CheckpointResult,
  latestCheckpoint,
  recordFailedIdlePreservation,
} from './checkpoint.ts'
import type { CheckpointSchedule } from './checkpoint-schedule.ts'
import { questionOpenSql } from './question-open.ts'

/** The idle-kill outcome the caller carries into terminalisation. */
export type IdleKillState = {
  killed: boolean
  error: string | null
  unkillable: boolean
  treePids: number[]
  treePgid: number | null
}

function idleRunRow(runId: string): {
  status: string
  last_event_at: string | null
  started_at: string
} | null {
  return db()
    .query('SELECT status, last_event_at, started_at FROM run WHERE record_id=?')
    .get(runId) as {
    status: string
    last_event_at: string | null
    started_at: string
  } | null
}

function runHasOpenQuestion(runId: string): boolean {
  return Boolean(
    db()
      .query(
        `SELECT 1 n FROM question WHERE run_record_id=? AND ${questionOpenSql('question')} LIMIT 1`,
      )
      .get(runId),
  )
}

function recordedRunStatus(runId: string): string | null {
  return (
    (
      db().query('SELECT status FROM run WHERE record_id=?').get(runId) as {
        status: string
      } | null
    )?.status ?? null
  )
}

export function idleSnapshotObserver(
  runId: string,
  stopped: () => boolean,
  check: (samples: ProcessSample[]) => Promise<void>,
): (samples: ProcessSample[]) => void {
  let inFlight = false
  return (samples) => {
    if (inFlight || stopped()) return
    inFlight = true
    void check(samples)
      .catch((error) => {
        console.error(`orch: run ${runId} idle check failed: ${error}`)
      })
      .finally(() => {
        inFlight = false
      })
  }
}

export async function performIdleKill(input: {
  state: IdleKillState
  runId: string
  job: string
  boundMs: number
  vendorStartedAtMs: number
  timedOut: boolean
  samples: ProcessSample[]
  handle: TransportHandle
  cancel: () => void
  checkpoint: CheckpointSchedule<CheckpointResult | null>
  checkpointRootId: string
  scratchDir: string
  worktreePath: string | null
  forceCollect: (result: TransportResult) => void
}): Promise<void> {
  const { state } = input
  const row = idleRunRow(input.runId)
  if (!row) return
  const openQuestion = runHasOpenQuestion(input.runId)
  const idleThresholdMs = jobIdleKillMs(input.job, process.env, input.boundMs)
  const decision = shouldIdleKill({
    lastEventAt: row.last_event_at,
    startedAt: row.started_at,
    pid: input.handle.pid,
    asking: row.status === 'asking',
    openQuestion,
    alreadyTimedOut: input.timedOut,
    alreadyIdleKilled: state.killed,
    thresholdMs: idleThresholdMs,
    samples: input.samples,
  })
  if (!decision.kill) return
  state.killed = true
  const elapsed = Date.now() - input.vendorStartedAtMs
  state.error = formatIdleKillError({
    idleMs: decision.idleMs ?? 0,
    reclaimedMs: Math.max(0, input.boundMs - elapsed),
    boundMs: input.boundMs,
  })
  const checkpoint = input.checkpoint.request('limit')
  const afterCheckpoint = recordedRunStatus(input.runId)
  const askedDuringCheckpoint = afterCheckpoint === 'asking' || runHasOpenQuestion(input.runId)
  if (askedDuringCheckpoint) {
    state.killed = false
    state.error = null
    appendRunEvent(input.runId, {
      ts: nowIso(),
      type: 'text',
      text: 'idle kill aborted: worker asked during checkpoint',
    })
    return
  }
  const prior = latestCheckpoint(db(), input.checkpointRootId)
  if (!idleKillMayProceed(checkpoint, Boolean(prior))) {
    state.killed = false
    state.error = null
    const why = checkpoint?.error ?? 'checkpoint failed'
    console.error(
      `orch: run ${input.runId} idle kill aborted: ${why}; no prior checkpoint, leaving the worker for the wall`,
    )
    recordFailedIdlePreservation({
      runId: input.runId,
      scratchDir: input.scratchDir,
      worktree: input.worktreePath,
      error: why,
    })
    return
  }
  if (checkpoint?.created || prior) {
    db().query('UPDATE run SET work_preserved=1 WHERE record_id=?').run(input.runId)
  }
  input.cancel()
  const terminated = await terminateProcessGroup(input.handle.pid ?? 0, {
    direct: input.handle,
  })
  state.treePids = terminated.pids
  state.treePgid = terminated.pgid
  state.unkillable = terminated.unkillable
  if (terminated.unkillable) {
    state.error = formatIdleKillError({
      idleMs: decision.idleMs ?? 0,
      reclaimedMs: Math.max(0, input.boundMs - elapsed),
      boundMs: input.boundMs,
      unkillable: true,
      unkillableReason: terminated.reason,
    })
    input.forceCollect(unkillableIdleKillResult(state.error, input.handle.pid ?? 0))
  }
}

/** A collected-as-failed result for a vendor tree that survived SIGKILL. */
function unkillableIdleKillResult(error: string, pid: number): TransportResult {
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
    failureKind: 'idle',
    status: 'failed',
    questions: [],
  }
}
