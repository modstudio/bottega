import { expect, test } from 'bun:test'
import { JOBS } from './jobs.ts'

test('jobs exposes fidelity only for writing jobs', () => {
  expect(JOBS.implement!.needs.writesRepo).toBe(true)
  expect(JOBS.fix!.needs.writesRepo).toBe(true)
  expect(JOBS['review-lens']!.needs.writesRepo).not.toBe(true)
})
