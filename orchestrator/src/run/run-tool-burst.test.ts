import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import { scoreboard } from '../route/route.ts'
import {
  applyToolBurstOutcome,
  newToolBurstState,
  observeToolBurst,
  performToolBurstKill,
  recordToolBurstObservation,
  settleToolBurst,
} from './run-tool-burst.ts'
import { formatToolCallBurstError, TOOL_CALL_BURST_LIMIT } from './tool-call-burst.ts'

const terminated = {
  exited: true,
  unkillable: false,
  reason: null,
  pgid: 42,
  pids: [42],
}

test('one start followed by many updates counts once', () => {
  const state = newToolBurstState()
  const observe = (phase: 'start' | 'update', toolCallId?: string) =>
    observeToolBurst({
      state,
      event: { kind: 'tool', phase, toolCallId, title: 'rg' },
      harness: 'goose',
      nowMs: 100,
      kill: async () => {},
    })
  observe('start', 'same')
  for (let index = 0; index < 100; index++) observe('update', 'same')
  observe('update', 'different')
  observe('update')
  expect(state.burst.windowStartsMs).toEqual([100])
  expect(state.burst).toMatchObject({ tripped: false, peakCount: 1 })
})

test('a goose burst kills once and applies its terminal outcome; codex only observes', async () => {
  for (const [harness, expectedKills] of [
    ['goose', 1],
    ['codex', 0],
  ] as const) {
    const state = newToolBurstState()
    let kills = 0
    for (let index = 0; index <= TOOL_CALL_BURST_LIMIT + 1; index++) {
      observeToolBurst({
        state,
        event: { kind: 'tool', phase: 'start', toolCallId: `call-${index}`, title: 'rg' },
        harness,
        nowMs: index,
        kill: async () => {
          kills++
        },
      })
    }
    await state.termination
    expect(kills).toBe(expectedKills)
    expect(state.burst.tripped).toBe(true)
    if (harness === 'goose') {
      expect(state.killed).toBe(true)
      expect(state.error).toBe(formatToolCallBurstError(state.burst))
      expect(
        applyToolBurstOutcome(state, {
          status: 'ok',
          failureKind: null,
          error: null,
        }),
      ).toEqual({ status: 'failed', failureKind: 'tool_burst', error: state.error })
    } else {
      expect(state.killed).toBe(false)
    }
  }
})

test('a writing burst kills first and checkpoints before terminalization without spawning', async () => {
  const order: string[] = []
  await performToolBurstKill({
    state: newToolBurstState(),
    handle: { pid: 42 } as never,
    cancel: () => order.push('cancel'),
    terminate: async () => {
      order.push('terminate')
      return terminated
    },
    forceCollect: () => order.push('forceCollect'),
    checkpoint: {
      request: (trigger) => {
        order.push(`checkpoint:${trigger}`)
        return null
      },
      executionStarted() {},
      executionFinished() {},
    },
    writesJob: true,
  })
  expect(order).toEqual(['cancel', 'terminate', 'checkpoint:limit'])
})

test('an unkillable burst forces collection and retains its process tree', async () => {
  const state = newToolBurstState()
  state.error = 'tool-call burst'
  const forced: unknown[] = []
  await performToolBurstKill({
    state,
    handle: { pid: 42 } as never,
    cancel: () => {},
    terminate: async () => ({
      exited: false,
      unkillable: true,
      reason: 'process did not exit after SIGKILL; needs a human',
      pgid: 40,
      pids: [42, 43],
    }),
    checkpoint: {
      request: () => null,
      executionStarted() {},
      executionFinished() {},
    },
    writesJob: false,
    forceCollect: (result) => forced.push(result),
  })
  expect(state.terminateResult).toMatchObject({
    unkillable: true,
    pgid: 40,
    pids: [42, 43],
  })
  expect(forced).toHaveLength(1)
  expect(forced[0]).toMatchObject({ failureKind: 'tool_burst', status: 'failed', pid: 42 })
})

test('an observed burst is persisted and appended at most once per run', () => {
  const runId = addRun({ agent: 'codex', job: 'craft' })
  const burst = {
    tripped: true,
    peakCount: 64,
    peakAtMs: Date.parse('2026-10-31T12:00:00Z'),
    windowStartsMs: [],
  }
  recordToolBurstObservation(runId, burst)
  recordToolBurstObservation(runId, { ...burst, peakCount: 80 })
  expect(
    db()
      .query('SELECT tool_burst_observed_peak,tool_burst_observed_at FROM run WHERE record_id=?')
      .get(runId),
  ).toEqual({
    tool_burst_observed_peak: 64,
    tool_burst_observed_at: '2026-10-31T12:00:00.000Z',
  })
})

test('settled killed and observed bursts both reach agent stats', async () => {
  const killedRun = addRun({ agent: 'grok', job: 'craft', status: 'failed', kind: 'tool_burst' })
  const observedRun = addRun({ agent: 'codex', job: 'craft' })
  const trip = (harness: 'goose' | 'codex', extraStarts = 0) => {
    const state = newToolBurstState()
    for (let index = 0; index <= TOOL_CALL_BURST_LIMIT + extraStarts; index++) {
      observeToolBurst({
        state,
        event: { kind: 'tool', phase: 'start', toolCallId: `call-${index}`, title: 'rg' },
        harness,
        nowMs: index,
        kill: async () => {},
      })
    }
    return state
  }
  const killed = trip('goose')
  const observed = trip('codex', 1)

  await settleToolBurst(killedRun, killed)
  await settleToolBurst(observedRun, observed)

  expect(scoreboard('craft').find((row) => row.agent === 'grok')?.toolBursts).toEqual({
    runs: 1,
    peak: TOOL_CALL_BURST_LIMIT + 1,
  })
  expect(scoreboard('craft').find((row) => row.agent === 'codex')?.toolBursts).toEqual({
    runs: 1,
    peak: TOOL_CALL_BURST_LIMIT + 2,
  })
})
