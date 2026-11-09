import { describe, expect, test } from 'bun:test'
import { watchCycleDecision } from './collect-watch-schedule.ts'

describe('watch cycle decision', () => {
  test('owes one slow cycle while busy and runs it before another fast cycle', () => {
    expect(
      watchCycleDecision({ busy: true, slowOwed: false, tick: 'slow', stopping: false }),
    ).toEqual({ run: null, slowOwed: true })
    expect(
      watchCycleDecision({ busy: true, slowOwed: true, tick: 'slow', stopping: false }),
    ).toEqual({ run: null, slowOwed: true })
    expect(
      watchCycleDecision({ busy: false, slowOwed: true, tick: 'fast', stopping: false }),
    ).toEqual({ run: 'slow', slowOwed: false })
  })

  test('runs ordinary ticks only while idle and not stopping', () => {
    expect(
      watchCycleDecision({ busy: false, slowOwed: false, tick: 'fast', stopping: false }),
    ).toEqual({ run: 'fast', slowOwed: false })
    expect(
      watchCycleDecision({ busy: false, slowOwed: false, tick: 'slow', stopping: false }),
    ).toEqual({ run: 'slow', slowOwed: false })
    expect(watchCycleDecision({ busy: false, slowOwed: true, tick: null, stopping: true })).toEqual(
      { run: null, slowOwed: true },
    )
  })
})
