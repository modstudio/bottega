import { describe, expect, test } from 'bun:test'
import {
  accumulateRunResourceUsage,
  finalRunResourceUsage,
  parseProcessSnapshot,
  processTreePids,
  type RunResourceUsage,
} from './process-resource-sampler.ts'

const birth = 'Wed Oct 21 10:00:00 2026'
const empty: RunResourceUsage = { cpuMs: null, peakRssBytes: null, samples: 0, source: 'none' }

describe('run process resource accumulation', () => {
  test('finds only the root and descendants in one process-table snapshot', () => {
    const rows = parseProcessSnapshot(
      `10 1 10 1.0 S 100 00:01 ${birth}\n11 10 10 2.0 S 200 00:02 ${birth}\n12 11 10 3.0 S 300 00:03 ${birth}\n20 1 20 4.0 S 400 00:04 ${birth}`,
    )
    expect(processTreePids(10, rows).sort((a, b) => a - b)).toEqual([10, 11, 12])
  })

  test('keeps peak summed RSS and maximum observed summed CPU across samples', () => {
    const first = accumulateRunResourceUsage(
      empty,
      10,
      birth,
      parseProcessSnapshot(`10 1 10 1.0 S 100 00:01 ${birth}\n11 10 10 2.0 S 200 00:02 ${birth}`),
    )
    const second = accumulateRunResourceUsage(
      first,
      10,
      birth,
      parseProcessSnapshot(`10 1 10 1.0 S 500 00:02 ${birth}\n11 10 10 2.0 S 100 00:03 ${birth}`),
    )
    const third = accumulateRunResourceUsage(
      second,
      10,
      birth,
      parseProcessSnapshot(`10 1 10 1.0 S 100 00:02 ${birth}`),
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
      birth,
      parseProcessSnapshot(`10 1 10 99.0 R 999999 10:00 Thu Oct 22 10:00:00 2026`),
    )
    expect(observed).toEqual(empty)
  })

  test('distinguishes an unobserved tree from an unavailable process table', () => {
    expect(finalRunResourceUsage(empty, 1)).toEqual(empty)
    expect(finalRunResourceUsage(empty, 0)).toEqual({ ...empty, source: 'unavailable' })
  })
})
