import { expect, test } from 'bun:test'
import { nearestRankPercentile } from './statistics.ts'

test('nearest-rank percentile uses the lower middle for an even sample', () => {
  expect(nearestRankPercentile([4, 1, 3, 2], 0.5)).toBe(2)
  expect(nearestRankPercentile([4, 1, 3, 2], 0.9)).toBe(4)
  expect(nearestRankPercentile([], 0.5)).toBeNull()
})
