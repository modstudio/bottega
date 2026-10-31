import { expect, test } from 'bun:test'
import { addRun } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  newToolBurstState,
  observeToolBurst,
  performToolBurstKill,
  recordToolBurstObservation,
} from './run-tool-burst.ts'

test('one start followed by many updates counts once', () => {
  const state = newToolBurstState()
  const starts: number[] = []
  const seenToolCallIds = new Set<string>()
  const observe = (phase: 'start' | 'update') =>
    observeToolBurst({
      state,
      event: { kind: 'tool', phase, toolCallId: 'same', title: 'rg' },
      harness: 'goose',
      starts,
      seenToolCallIds,
      nowMs: 100,
      kill: async () => {},
    })
  observe('start')
  for (let index = 0; index < 100; index++) observe('update')
  expect(starts).toEqual([100])
  expect(state.burst).toMatchObject({ tripped: false, peakCount: 1 })
})

test('a writing burst kills first and checkpoints before terminalization without spawning', async () => {
  const order: string[] = []
  await performToolBurstKill({
    handle: { pid: 42 } as never,
    cancel: () => order.push('cancel'),
    terminate: async () => {
      order.push('terminate')
    },
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

test('an observed burst is persisted and appended at most once per run', () => {
  const runId = addRun({ agent: 'codex', job: 'craft' })
  const burst = { tripped: true, peakCount: 64, peakAtMs: Date.parse('2026-10-31T12:00:00Z') }
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
