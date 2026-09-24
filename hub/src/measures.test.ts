import { describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import {
  computeMeasures,
  leftoverSilence,
  type MeasureInterval,
  type MeasureStatusEvent,
  SILENCE_ALLOWANCE_MS,
  SILENCE_ALLOWANCE_SENTENCE,
} from './measures.ts'

const FROM = '2026-09-17T12:00:00.000Z'
const TO = '2026-09-17T14:00:00.000Z'
const WINDOW = { from: FROM, to: TO }
const MAYA = '01990000-0000-7000-8000-000000000001'
const ALEX = '01990000-0000-7000-8000-000000000002'
const HOUR = 3_600_000

function interval(
  overrides: Partial<MeasureInterval> & Pick<MeasureInterval, 'source' | 'startAt' | 'endAt'>,
): MeasureInterval {
  return {
    open: 0,
    userId: null,
    taskId: 'task-758',
    taskKey: 'DEV-758',
    project: PLATFORM_SLUG,
    vendorTokens: 0,
    vendorCostUsd: null,
    ...overrides,
  }
}

function event(overrides: Partial<MeasureStatusEvent> = {}): MeasureStatusEvent {
  return {
    taskId: 'task-758',
    taskKey: 'DEV-758',
    project: PLATFORM_SLUG,
    at: '2026-09-17T13:00:00.000Z',
    toStatus: 'done',
    ...overrides,
  }
}

describe('silence allowance', () => {
  test('is ten minutes, with the sentence the interface prints', () => {
    expect(SILENCE_ALLOWANCE_MS).toBe(10 * 60_000)
    expect(SILENCE_ALLOWANCE_SENTENCE).toBe('Silences longer than ten minutes are not counted.')
  })
})

describe('hours running and agent-hours', () => {
  test('overlapping agent intervals: hours running merges them, agent-hours adds them', () => {
    const rows = {
      intervals: [
        interval({
          source: 'orch',
          startAt: '2026-09-17T12:00:00.000Z',
          endAt: '2026-09-17T13:00:00.000Z',
          userId: MAYA,
        }),
        interval({
          source: 'orch',
          startAt: '2026-09-17T12:30:00.000Z',
          endAt: '2026-09-17T13:30:00.000Z',
          userId: MAYA,
        }),
      ],
      events: [],
    }
    const measures = computeMeasures(rows, WINDOW, { kind: 'space' })
    expect(measures.hoursRunning.notAdditive).toBe(true)
    expect(measures.hoursRunning.unionMs).toBe(HOUR * 1.5)
    expect(measures.agentHours.from).toBe('started')
    expect(measures.agentHours.sumMs).toBe(HOUR * 2)
  })

  test('a person within a project excludes their evidence from other projects', () => {
    const rows = {
      intervals: [
        interval({
          source: 'orch',
          startAt: '2026-09-17T12:00:00.000Z',
          endAt: '2026-09-17T13:00:00.000Z',
          userId: MAYA,
          project: PLATFORM_SLUG,
        }),
        interval({
          source: 'orch',
          startAt: '2026-09-17T12:00:00.000Z',
          endAt: '2026-09-17T14:00:00.000Z',
          userId: MAYA,
          project: 'other',
        }),
      ],
      events: [],
    }
    expect(
      computeMeasures(rows, WINDOW, {
        kind: 'person',
        userId: MAYA,
        project: PLATFORM_SLUG,
      }).agentHours.sumMs,
    ).toBe(HOUR)
  })

  test('members scope combines only the selected members across projects', () => {
    const rows = {
      intervals: [
        interval({ source: 'orch', startAt: FROM, endAt: TO, userId: MAYA, project: 'one' }),
        interval({ source: 'orch', startAt: FROM, endAt: TO, userId: ALEX, project: 'two' }),
        interval({
          source: 'orch',
          startAt: FROM,
          endAt: TO,
          userId: '01990000-0000-7000-8000-000000000003',
          project: 'three',
        }),
      ],
      events: [event()],
    }
    const measures = computeMeasures(rows, WINDOW, { kind: 'members', userIds: [MAYA, ALEX] })
    expect(measures.scope).toBe('members')
    expect(measures.agentHours.sumMs).toBe(HOUR * 4)
    expect('shipped' in measures).toBe(false)
  })
})

describe('session time', () => {
  test('one person with two overlapping sessions accrues one hour', () => {
    const rows = {
      intervals: [
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:00:00.000Z',
          endAt: '2026-09-17T13:00:00.000Z',
          userId: MAYA,
        }),
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:30:00.000Z',
          endAt: '2026-09-17T13:00:00.000Z',
          userId: MAYA,
        }),
      ],
      events: [],
    }
    const measures = computeMeasures(rows, WINDOW, { kind: 'space' })
    expect(measures.sessionTime.from).toBe('session')
    expect(measures.sessionTime.unionThenSumMs).toBe(HOUR)
    expect(measures.sessionTime.uncountedSilenceMs).toBe(0)
  })

  test('two people in the same hour accrue two', () => {
    const rows = {
      intervals: [
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:00:00.000Z',
          endAt: '2026-09-17T13:00:00.000Z',
          userId: MAYA,
        }),
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:00:00.000Z',
          endAt: '2026-09-17T13:00:00.000Z',
          userId: ALEX,
        }),
      ],
      events: [],
    }
    expect(computeMeasures(rows, WINDOW, { kind: 'space' }).sessionTime.unionThenSumMs).toBe(
      HOUR * 2,
    )
  })

  test('a gap longer than the allowance credits the allowance and reports the remainder as uncounted silence', () => {
    const rows = {
      intervals: [
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:00:00.000Z',
          endAt: '2026-09-17T12:10:00.000Z',
          userId: MAYA,
        }),
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:35:00.000Z',
          endAt: '2026-09-17T12:40:00.000Z',
          userId: MAYA,
        }),
      ],
      events: [],
    }
    const measures = computeMeasures(rows, WINDOW, { kind: 'space' })
    expect(measures.sessionTime.unionThenSumMs).toBe(
      10 * 60_000 + SILENCE_ALLOWANCE_MS + 5 * 60_000,
    )
    expect(measures.sessionTime.uncountedSilenceMs).toBe(15 * 60_000)
  })

  test("a gap while that person's own agent runs credits nothing and is not uncounted silence", () => {
    const rows = {
      intervals: [
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:00:00.000Z',
          endAt: '2026-09-17T12:10:00.000Z',
          userId: MAYA,
        }),
        interval({
          source: 'orch',
          startAt: '2026-09-17T12:10:00.000Z',
          endAt: '2026-09-17T12:35:00.000Z',
          userId: MAYA,
        }),
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:35:00.000Z',
          endAt: '2026-09-17T12:40:00.000Z',
          userId: MAYA,
        }),
      ],
      events: [],
    }
    const measures = computeMeasures(rows, WINDOW, { kind: 'space' })
    expect(measures.sessionTime.unionThenSumMs).toBe(15 * 60_000)
    expect(measures.sessionTime.uncountedSilenceMs).toBe(0)
  })

  test('a partially covered gap subtracts waiting and applies the allowance to leftover silence', () => {
    const gap = { start: 0, end: 25 * 60_000 }
    const leftover = leftoverSilence(gap, [{ start: 5 * 60_000, end: 20 * 60_000 }])
    expect(leftover).toEqual([
      { start: 0, end: 5 * 60_000 },
      { start: 20 * 60_000, end: 25 * 60_000 },
    ])
    const rows = {
      intervals: [
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:00:00.000Z',
          endAt: '2026-09-17T12:05:00.000Z',
          userId: MAYA,
        }),
        interval({
          source: 'orch',
          startAt: '2026-09-17T12:10:00.000Z',
          endAt: '2026-09-17T12:25:00.000Z',
          userId: MAYA,
        }),
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:30:00.000Z',
          endAt: '2026-09-17T12:35:00.000Z',
          userId: MAYA,
        }),
      ],
      events: [],
    }
    const measures = computeMeasures(rows, WINDOW, { kind: 'space' })
    expect(measures.sessionTime.unionThenSumMs).toBe(20 * 60_000)
    expect(measures.sessionTime.uncountedSilenceMs).toBe(0)
  })

  test('one silence gets one allowance however the waiting cuts it', () => {
    // A one-minute agent run in the middle of a 25-minute silence must not split
    // it into two allowances: crediting each piece would make more agent activity
    // read as more attention.
    const rows = {
      intervals: [
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:00:00.000Z',
          endAt: '2026-09-17T12:05:00.000Z',
          userId: MAYA,
        }),
        interval({
          source: 'orch',
          startAt: '2026-09-17T12:17:00.000Z',
          endAt: '2026-09-17T12:18:00.000Z',
          userId: MAYA,
        }),
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:30:00.000Z',
          endAt: '2026-09-17T12:35:00.000Z',
          userId: MAYA,
        }),
      ],
      events: [],
    }
    const measures = computeMeasures(rows, WINDOW, { kind: 'space' })
    // Ten minutes in session, plus one ten-minute allowance for the 24 minutes of
    // leftover silence, with the remaining fourteen reported as uncounted.
    expect(measures.sessionTime.unionThenSumMs).toBe(20 * 60_000)
    expect(measures.sessionTime.uncountedSilenceMs).toBe(14 * 60_000)
  })

  test("intervals with no user land in the unknown total and never in a person's", () => {
    const rows = {
      intervals: [
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:00:00.000Z',
          endAt: '2026-09-17T13:00:00.000Z',
          userId: null,
        }),
        interval({
          source: 'claude',
          startAt: '2026-09-17T12:00:00.000Z',
          endAt: '2026-09-17T12:30:00.000Z',
          userId: MAYA,
        }),
      ],
      events: [],
    }
    const space = computeMeasures(rows, WINDOW, { kind: 'space' })
    expect(space.sessionTime.unionThenSumMs).toBe(HOUR / 2)
    expect(space.sessionTime.unknownUser?.unionThenSumMs).toBe(HOUR)
    const person = computeMeasures(rows, WINDOW, { kind: 'person', userId: MAYA })
    expect(person.sessionTime.unionThenSumMs).toBe(HOUR / 2)
    expect(person.sessionTime.unknownUser).toBeUndefined()
    expect(person.scope).toBe('person')
    expect('shipped' in person).toBe(false)
    expect('cycleTime' in person).toBe(false)
  })
})

describe('shipped and cycle time', () => {
  test('shipped counts a task once even when it enters a done category twice', () => {
    const rows = {
      intervals: [],
      events: [
        event({ at: '2026-09-17T12:10:00.000Z' }),
        event({ at: '2026-09-17T12:50:00.000Z' }),
        event({ taskId: 'task-759', taskKey: 'DEV-759', at: '2026-09-17T12:20:00.000Z' }),
      ],
    }
    const measures = computeMeasures(rows, WINDOW, { kind: 'space' })
    expect(measures.scope === 'space' && measures.shipped.count).toBe(2)
    expect(measures.scope === 'space' && measures.shipped.sample.eventCount).toBe(3)
  })

  test('cycle time returns median, ninetieth percentile and count', () => {
    const rows = {
      intervals: [
        interval({
          source: 'orch',
          startAt: '2026-09-17T10:00:00.000Z',
          endAt: '2026-09-17T10:05:00.000Z',
          taskKey: 'DEV-1',
          taskId: 'task-1',
          userId: MAYA,
        }),
        interval({
          source: 'claude',
          startAt: '2026-09-17T11:00:00.000Z',
          endAt: '2026-09-17T11:05:00.000Z',
          taskKey: 'DEV-2',
          taskId: 'task-2',
          userId: MAYA,
        }),
        interval({
          source: 'orch',
          startAt: '2026-09-17T09:00:00.000Z',
          endAt: '2026-09-17T09:05:00.000Z',
          taskKey: 'DEV-3',
          taskId: 'task-3',
          userId: MAYA,
        }),
      ],
      events: [
        event({ taskId: 'task-1', taskKey: 'DEV-1', at: '2026-09-17T12:10:00.000Z' }),
        event({ taskId: 'task-2', taskKey: 'DEV-2', at: '2026-09-17T12:20:00.000Z' }),
        event({ taskId: 'task-3', taskKey: 'DEV-3', at: '2026-09-17T12:30:00.000Z' }),
      ],
    }
    const measures = computeMeasures(rows, WINDOW, { kind: 'space' })
    expect(measures.scope).toBe('space')
    if (measures.scope === 'person' || measures.scope === 'members')
      throw new Error('expected space')
    expect(measures.cycleTime?.n).toBe(3)
    const samples = [
      Date.parse('2026-09-17T12:10:00.000Z') - Date.parse('2026-09-17T10:00:00.000Z'),
      Date.parse('2026-09-17T12:20:00.000Z') - Date.parse('2026-09-17T11:00:00.000Z'),
      Date.parse('2026-09-17T12:30:00.000Z') - Date.parse('2026-09-17T09:00:00.000Z'),
    ].sort((left, right) => left - right)
    expect(measures.cycleTime?.medianMs).toBe(samples[1])
    expect(measures.cycleTime?.n).toBe(3)
    expect(measures.cycleTime?.p90Ms).toBeGreaterThanOrEqual(samples[1]!)
  })

  test('cycle time is absent rather than zero when nothing shipped', () => {
    const measures = computeMeasures({ intervals: [], events: [] }, WINDOW, { kind: 'space' })
    expect(measures.scope).toBe('space')
    if (measures.scope === 'person' || measures.scope === 'members')
      throw new Error('expected space')
    expect(measures.shipped.count).toBe(0)
    expect(measures.cycleTime).toBeUndefined()
    expect('cycleTime' in measures).toBe(false)
  })

  test('equal task labels in separate spaces remain separate by record id', () => {
    const rows = {
      intervals: [
        interval({
          source: 'orch',
          startAt: '2026-09-17T10:00:00.000Z',
          endAt: '2026-09-17T10:05:00.000Z',
          taskId: 'task-space-a',
          taskKey: 'DEV-1',
        }),
        interval({
          source: 'orch',
          startAt: '2026-09-17T11:00:00.000Z',
          endAt: '2026-09-17T11:05:00.000Z',
          taskId: 'task-space-b',
          taskKey: 'DEV-1',
        }),
      ],
      events: [
        event({ taskId: 'task-space-a', taskKey: 'DEV-1', at: '2026-09-17T12:10:00.000Z' }),
        event({ taskId: 'task-space-b', taskKey: 'DEV-1', at: '2026-09-17T12:20:00.000Z' }),
      ],
    }

    const measures = computeMeasures(rows, WINDOW, { kind: 'space' })
    if (measures.scope === 'person') throw new Error('expected space')
    expect(measures.shipped.count).toBe(2)
    expect(measures.cycleTime?.n).toBe(2)
  })

  test('a shipped task with no intervals is omitted from the cycle-time distribution', () => {
    const measures = computeMeasures({ intervals: [], events: [event()] }, WINDOW, {
      kind: 'space',
    })
    if (measures.scope === 'person' || measures.scope === 'members')
      throw new Error('expected space')
    expect(measures.shipped.count).toBe(1)
    expect(measures.cycleTime).toBeUndefined()
  })
})

describe('cost', () => {
  test('adds vendor_cost_usd with vendor tokens beside it', () => {
    const rows = {
      intervals: [
        interval({
          source: 'orch',
          startAt: '2026-09-17T12:00:00.000Z',
          endAt: '2026-09-17T12:10:00.000Z',
          userId: MAYA,
          vendorTokens: 100,
          vendorCostUsd: 0.4,
        }),
        interval({
          source: 'orch',
          startAt: '2026-09-17T12:10:00.000Z',
          endAt: '2026-09-17T12:20:00.000Z',
          userId: null,
          vendorTokens: 50,
          vendorCostUsd: 0.1,
        }),
      ],
      events: [],
    }
    const space = computeMeasures(rows, WINDOW, { kind: 'space' })
    expect(space.cost.from).toBe('started')
    expect(space.cost.vendorCostUsd).toBe(0.5)
    expect(space.cost.vendorTokens).toBe(150)
    expect(space.cost.unknownShare).toEqual({
      vendorCostUsd: 0.1,
      vendorTokens: 50,
      intervalCount: 1,
    })
  })
})
