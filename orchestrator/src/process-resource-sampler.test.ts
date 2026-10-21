import { describe, expect, test } from 'bun:test'
import {
  accumulateRunResourceUsage,
  parseProcessSnapshot,
  processTreePids,
  type RunResourceUsage,
} from './process-resource-sampler.ts'

const empty: RunResourceUsage = { cpuMs: 0, peakRssBytes: 0, samples: 0, source: 'sampled' }

describe('run process resource accumulation', () => {
  test('finds only the root and descendants in one process-table snapshot', () => {
    const rows = parseProcessSnapshot(
      '10 1 10 1.0 S 100 00:01\n11 10 10 2.0 S 200 00:02\n12 11 10 3.0 S 300 00:03\n20 1 20 4.0 S 400 00:04',
    )
    expect(processTreePids(10, rows).sort((a, b) => a - b)).toEqual([10, 11, 12])
  })

  test('keeps peak summed RSS and maximum observed summed CPU across samples', () => {
    const first = accumulateRunResourceUsage(
      empty,
      10,
      parseProcessSnapshot('10 1 10 1.0 S 100 00:01\n11 10 10 2.0 S 200 00:02'),
    )
    const second = accumulateRunResourceUsage(
      first,
      10,
      parseProcessSnapshot('10 1 10 1.0 S 500 00:02\n11 10 10 2.0 S 100 00:03'),
    )
    const third = accumulateRunResourceUsage(
      second,
      10,
      parseProcessSnapshot('10 1 10 1.0 S 100 00:02'),
    )
    expect(third).toEqual({
      cpuMs: 5_000,
      peakRssBytes: 600 * 1_024,
      samples: 3,
      source: 'sampled',
    })
  })
})
