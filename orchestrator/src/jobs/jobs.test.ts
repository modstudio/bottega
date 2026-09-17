import { expect, test } from 'bun:test'
import { JOBS, jobTimeoutCeilingMinutes, resolveJobTimeoutMs } from './jobs.ts'

test('jobs exposes fidelity only for writing jobs', () => {
  expect(JOBS.implement!.needs.writesRepo).toBe(true)
  expect(JOBS.fix!.needs.writesRepo).toBe(true)
  expect(JOBS['review-lens']!.needs.writesRepo).not.toBe(true)
})

test('the timeout override respects the ceiling', () => {
  const fileQuestion = JOBS['file-question']!
  expect(jobTimeoutCeilingMinutes(fileQuestion)).toBe(20)
  expect(() => resolveJobTimeoutMs(fileQuestion, 25 * 60_000, 21)).toThrow(
    'file-question timeout ceiling is 20 minutes',
  )
  expect(resolveJobTimeoutMs(fileQuestion, 25 * 60_000, 20)).toBe(20 * 60_000)
  expect(() => resolveJobTimeoutMs(JOBS.diagnose!, 20 * 60_000, 60)).toThrow('stale cutoff')
})
