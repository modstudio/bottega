import { describe, expect, test } from 'bun:test'
import {
  accumulateRunResourceUsage,
  advanceRunResourceUsage,
  finalRunResourceUsage,
  liveProcessTreePids,
  observedProcessTreePids,
  PROCESS_SNAPSHOT_FIELDS,
  parseProcessSnapshot,
  type RunResourceUsage,
} from './process-resource-sampler.ts'

const birth = 'Wed Oct 21 10:00:00 2026'
const empty: RunResourceUsage = {
  cpuMs: null,
  peakRssBytes: null,
  samples: 0,
  source: 'none',
}

describe('run process resource accumulation', () => {
  test('finds only the root and descendants in one process-table snapshot', () => {
    const rows = parseProcessSnapshot(
      `10 1 10 1.0 S 100 00:01 ${birth}\n11 10 10 2.0 S 200 00:02 ${birth}\n12 11 10 3.0 S 300 00:03 ${birth}\n20 1 20 4.0 S 400 00:04 ${birth}`,
    )
    expect(observedProcessTreePids(10, rows).sort((a, b) => a - b)).toEqual([10, 11, 12])
  })

  test('parses the fields requested from ps in their pinned order', () => {
    const values: Record<(typeof PROCESS_SNAPSHOT_FIELDS)[number], string> = {
      pid: '10',
      ppid: '1',
      pgid: '10',
      '%cpu': '1.5',
      state: 'S',
      rss: '256',
      time: '00:02',
      lstart: birth,
    }
    expect(
      parseProcessSnapshot(PROCESS_SNAPSHOT_FIELDS.map((field) => values[field]).join(' ')),
    ).toEqual([
      {
        pid: 10,
        ppid: 1,
        pgid: 10,
        cpu: 1.5,
        state: 'S',
        rssBytes: 256 * 1_024,
        cpuMs: 2_000,
        startTime: birth,
      },
    ])
  })

  test('liveness keeps a recorded root when the process snapshot is empty', () => {
    expect(observedProcessTreePids(10, [])).toEqual([])
    expect(liveProcessTreePids(10, [])).toEqual([10])
  })

  test('keeps peak summed RSS and maximum observed summed CPU across samples', () => {
    const first = accumulateRunResourceUsage(
      empty,
      10,
      parseProcessSnapshot(`10 1 10 1.0 S 100 00:01 ${birth}\n11 10 10 2.0 S 200 00:02 ${birth}`),
      true,
    )
    const second = accumulateRunResourceUsage(
      first,
      10,
      parseProcessSnapshot(`10 1 10 1.0 S 500 00:02 ${birth}\n11 10 10 2.0 S 100 00:03 ${birth}`),
      true,
    )
    const third = accumulateRunResourceUsage(
      second,
      10,
      parseProcessSnapshot(`10 1 10 1.0 S 100 00:02 ${birth}`),
      true,
    )
    expect(third).toEqual({
      cpuMs: 5_000,
      peakRssBytes: 600 * 1_024,
      samples: 3,
      source: 'sampled',
    })
  })

  test('does not count a recycled root pid with a different birth time', () => {
    const observed = accumulateRunResourceUsage(
      empty,
      10,
      parseProcessSnapshot(`10 1 10 99.0 R 999999 10:00 Thu Oct 22 10:00:00 2026`),
      false,
    )
    expect(observed).toEqual(empty)
  })

  test('stops accumulating after the root disappears, including a recycled pid fixture', () => {
    const gone = advanceRunResourceUsage({ usage: empty, active: true }, 10, [], false)
    const recycled = advanceRunResourceUsage(
      gone,
      10,
      parseProcessSnapshot(`10 1 10 99.0 R 999999 10:00 Thu Oct 22 10:00:00 2026`),
      false,
    )
    expect(gone.active).toBe(false)
    expect(recycled).toEqual(gone)
  })

  test('distinguishes an unobserved tree from an unavailable process table', () => {
    expect(finalRunResourceUsage(empty, 1)).toEqual(empty)
    expect(finalRunResourceUsage(empty, 0)).toEqual({
      ...empty,
      source: 'unavailable',
    })
  })
})
