import { describe, expect, test } from 'bun:test'
import { watchCycleDecision } from './collect-watch-schedule.ts'

describe('watch cycle decision', () => {
  test('owes one slow cycle while busy and runs it before another fast cycle', () => {
    expect(
      watchCycleDecision({ running: 'fast', slowOwed: false, tick: 'slow', stopping: false }),
    ).toEqual({ run: null, slowOwed: true })
    expect(
      watchCycleDecision({ running: 'fast', slowOwed: true, tick: 'slow', stopping: false }),
    ).toEqual({ run: null, slowOwed: true })
    expect(
      watchCycleDecision({ running: null, slowOwed: true, tick: 'fast', stopping: false }),
    ).toEqual({ run: 'slow', slowOwed: false })
  })

  test('does not owe another slow cycle when a slow tick lands during slow work', () => {
    expect(
      watchCycleDecision({ running: 'slow', slowOwed: false, tick: 'slow', stopping: false }),
    ).toEqual({ run: null, slowOwed: false })
  })

  test('runs ordinary ticks only while idle and not stopping', () => {
    expect(
      watchCycleDecision({ running: null, slowOwed: false, tick: 'fast', stopping: false }),
    ).toEqual({ run: 'fast', slowOwed: false })
    expect(
      watchCycleDecision({ running: null, slowOwed: false, tick: 'slow', stopping: false }),
    ).toEqual({ run: 'slow', slowOwed: false })
    expect(
      watchCycleDecision({ running: null, slowOwed: true, tick: null, stopping: true }),
    ).toEqual({ run: null, slowOwed: true })
  })
})
