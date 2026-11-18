import { expect, test } from 'bun:test'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { ProcessSample } from '../process-resource-sampler.ts'
import type { TransportHandle } from '../transport/transport.ts'
import type { CheckpointResult } from './checkpoint.ts'
import type { CheckpointSchedule } from './checkpoint-schedule.ts'
import { type IdleKillState, performIdleKill } from './run-idle-kill.ts'

const VENDOR_PID = 987_654
const BOUND_MS = 60 * 60_000

function idleState(): IdleKillState {
  return {
    killed: false,
    error: null,
    unkillable: false,
    treePids: [],
    treePgid: null,
  }
}

function idleSample(): ProcessSample[] {
  return [{ pid: VENDOR_PID, ppid: 1, pgid: VENDOR_PID, cpu: 0, state: 'S' }]
}

function fakeHandle(): TransportHandle {
  return {
    pid: VENDOR_PID,
    kill() {},
    async prompt() {},
    async *events() {},
    async cancel() {},
    async collect() {
      throw new Error('collect is not used by idle-kill tests')
    },
  }
}

function checkpoint(
  request: () => CheckpointResult | null = () => null,
): CheckpointSchedule<CheckpointResult | null> {
  return {
    request,
    executionStarted() {},
    executionFinished() {},
  }
}

function idleRun(minutesSilent: number): string {
  const at = new Date(Date.now() - minutesSilent * 60_000).toISOString()
  const runId = addRun({ agent: 'codex', job: 'implement', status: 'running', startedAt: at })
  db().query('UPDATE run SET last_event_at=? WHERE record_id=?').run(at, runId)
  return runId
}

function performInput(
  runId: string,
  state: IdleKillState,
  hasOpenQuestion: (runId: string) => Promise<boolean>,
  overrides: { checkpoint?: CheckpointSchedule<CheckpointResult | null>; cancel?: () => void } = {},
) {
  return {
    state,
    runId,
    job: 'implement',
    boundMs: BOUND_MS,
    vendorStartedAtMs: Date.now() - 31 * 60_000,
    timedOut: false,
    samples: idleSample(),
    handle: fakeHandle(),
    cancel: overrides.cancel ?? (() => {}),
    checkpoint: overrides.checkpoint ?? checkpoint(),
    checkpointRootId: runId,
    scratchDir: dir,
    worktreePath: null,
    forceCollect() {},
    hasOpenQuestion,
  }
}

test('silence below the threshold makes no question-store reads over several ticks', async () => {
  const runId = idleRun(5)
  const state = idleState()
  let reads = 0
  const hasOpenQuestion = async () => {
    reads += 1
    return false
  }

  for (let tick = 0; tick < 4; tick += 1)
    await performIdleKill(performInput(runId, state, hasOpenQuestion))

  expect(reads).toBe(0)
  expect(state.killed).toBe(false)
})

test('threshold-crossed silence with an open question reads once and does not kill', async () => {
  const runId = idleRun(31)
  const state = idleState()
  let reads = 0

  await performIdleKill(
    performInput(runId, state, async () => {
      reads += 1
      return true
    }),
  )

  expect(reads).toBe(1)
  expect(state.killed).toBe(false)
})

test('threshold-crossed silence with no open question kills', async () => {
  const runId = idleRun(31)
  const state = idleState()
  let cancelled = false

  await performIdleKill(
    performInput(runId, state, async () => false, {
      cancel: () => {
        cancelled = true
      },
    }),
  )

  expect(state.killed).toBe(true)
  expect(cancelled).toBe(true)
})

test('an open question created during the checkpoint aborts the idle kill', async () => {
  const runId = idleRun(31)
  const state = idleState()
  const decisions = [false, true]
  let cancelled = false

  await performIdleKill(
    performInput(
      runId,
      state,
      async () => decisions.shift() ?? true,
      {
        checkpoint: checkpoint(),
        cancel: () => {
          cancelled = true
        },
      },
    ),
  )

  expect(state.killed).toBe(false)
  expect(state.error).toBeNull()
  expect(cancelled).toBe(false)
})
