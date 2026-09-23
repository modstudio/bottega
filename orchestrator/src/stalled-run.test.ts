import { describe, expect, test } from 'bun:test'
import { idleStallMs, stalledRunDetail, stalledRunState } from './stalled-run.ts'

describe('stalled run decision', () => {
  const base = {
    idleMs: 24 * 60_000,
    cpuMoving: false,
    idleBoundMs: 30 * 60_000,
    thresholdMs: 25 * 60_000,
  }

  test('distinguishes healthy, stalled, unknown, and the threshold boundary', () => {
    expect(stalledRunState(base)).toBe('healthy')
    expect(stalledRunState({ ...base, idleMs: 25 * 60_000 })).toBe('stalled')
    expect(stalledRunState({ ...base, idleMs: 29 * 60_000, cpuMoving: true })).toBe('healthy')
    expect(stalledRunState({ ...base, idleMs: 29 * 60_000, cpuMoving: null })).toBe('unknown')
  })

  test('the job idle bound keeps the reporting threshold reachable', () => {
    expect(stalledRunState({ ...base, idleMs: 19 * 60_000, idleBoundMs: 19 * 60_000 })).toBe(
      'stalled',
    )
  })

  test('the environment knob and operator line expose the measured default', () => {
    expect(idleStallMs({})).toBe(25 * 60_000)
    expect(idleStallMs({ ORCH_IDLE_STALL_MS: '400' })).toBe(400)
    expect(
      stalledRunDetail({
        id: 5406,
        agent: 'codex',
        job: 'review-lens',
        idleMs: 25 * 60_000,
        idleBoundMs: 30 * 60_000,
      }),
    ).toBe(
      'run 5406 codex/review-lens has been silent for 25m and has used no CPU in that time; stop it and re-dispatch, or wait for the 30m idle bound',
    )
  })
})
