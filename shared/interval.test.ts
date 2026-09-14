import { describe, expect, test } from 'bun:test'
import { DEFAULT_IDLE_CAP_MS, engagedMs, human, spansFromTimestamps, union } from './interval.ts'

const at = (iso: string) => new Date(iso).getTime()

describe('interval union', () => {
  test('a span on its own is its own length', () => {
    expect(engagedMs([{ start: 0, end: 5000 }])).toBe(5000)
  })

  test('overlapping spans are counted once', () => {
    expect(engagedMs([{ start: 0, end: 10_000 }, { start: 5000, end: 15_000 }])).toBe(15_000)
  })

  test('a span wholly inside another adds nothing', () => {
    expect(engagedMs([{ start: 0, end: 10_000 }, { start: 2000, end: 3000 }])).toBe(10_000)
  })

  test('disjoint spans add', () => {
    expect(engagedMs([{ start: 0, end: 1000 }, { start: 5000, end: 6000 }])).toBe(2000)
  })

  test('touching spans merge into one', () => {
    // A run finishing at the same instant the next message lands is continuous
    // work; a zero-width seam between them would be an artefact.
    expect(union([{ start: 0, end: 1000 }, { start: 1000, end: 2000 }])).toEqual([
      { start: 0, end: 2000 },
    ])
  })

  test('input order does not matter', () => {
    const a = engagedMs([{ start: 5000, end: 15_000 }, { start: 0, end: 10_000 }])
    const b = engagedMs([{ start: 0, end: 10_000 }, { start: 5000, end: 15_000 }])
    expect(a).toBe(b)
  })

  /**
   * The case the whole model exists for, with the real numbers.
   *
   * This session launched run 378 (grok) and run 379 (codex) from one Claude
   * session in ~/Projects/workshop. 379 started 8s after 378 and finished 26s
   * before it, so it is entirely contained.
   *
   * Summing agent durations says 7m54s of work happened. It did not: 4m14s of
   * wall-clock did, with two agents inside it. And the gap-capped
   * Claude-only model says roughly nothing happened at all, because Claude
   * sent no messages while it waited.
   */
  test('two concurrent delegated runs count as their union, not their sum', () => {
    const run378 = { start: at('2026-09-01T13:32:02.624Z'), end: at('2026-09-01T13:32:02.624Z') + 254_532 }
    const run379 = { start: at('2026-09-01T13:32:10.630Z'), end: at('2026-09-01T13:32:10.630Z') + 220_158 }

    expect(run379.start).toBeGreaterThan(run378.start)
    expect(run379.end).toBeLessThan(run378.end)

    expect(engagedMs([run378, run379])).toBe(254_532)
    expect(254_532 + 220_158).toBe(474_690) // what summing would have claimed
    expect(human(engagedMs([run378, run379]))).toBe('4m 15s')
  })

  test('a delegated run fills a gap Claude left empty', () => {
    // Claude sends a message, waits out a 4-minute agent run, then replies.
    // Under a 10-minute idle cap the Claude pair alone already covers it, but
    // the point is that the union does not double it.
    const t0 = at('2026-09-01T13:32:00.000Z')
    const claude = spansFromTimestamps([t0, t0 + 300_000], DEFAULT_IDLE_CAP_MS)
    const agent = [{ start: t0 + 10_000, end: t0 + 250_000 }]
    expect(engagedMs([...claude, ...agent])).toBe(300_000)
  })
})

describe('spans from timestamps', () => {
  test('a single message is no duration at all', () => {
    expect(spansFromTimestamps([at('2026-09-01T10:00:00Z')], DEFAULT_IDLE_CAP_MS)).toEqual([])
  })

  test('a gap under the cap is taken whole', () => {
    const t = at('2026-09-01T10:00:00Z')
    expect(engagedMs(spansFromTimestamps([t, t + 60_000], DEFAULT_IDLE_CAP_MS))).toBe(60_000)
  })

  test('a gap over the cap is truncated, not dropped', () => {
    // Overnight: the work either side is real, the eight hours between is not.
    const t = at('2026-09-01T10:00:00Z')
    expect(engagedMs(spansFromTimestamps([t, t + 8 * 3600_000], DEFAULT_IDLE_CAP_MS)))
      .toBe(DEFAULT_IDLE_CAP_MS)
  })

  test('a capped gap keeps its real start, so an agent run can overlap it', () => {
    // This is why capping happens per-pair rather than at the sum: the span
    // has coordinates, not just a length.
    const t = at('2026-09-01T10:00:00Z')
    const [span] = spansFromTimestamps([t, t + 3600_000], DEFAULT_IDLE_CAP_MS)
    expect(span!.start).toBe(t)
    expect(span!.end).toBe(t + DEFAULT_IDLE_CAP_MS)
  })
})

describe('human durations', () => {
  test.each([
    [0, '0s'],
    [12_000, '12s'],
    [90_000, '1m 30s'],
    [254_532, '4m 15s'],
    [3600_000, '1h 0m'],
    [8_040_000, '2h 14m'],
  ])('%i ms -> %s', (ms, out) => {
    expect(human(ms)).toBe(out)
  })
})
