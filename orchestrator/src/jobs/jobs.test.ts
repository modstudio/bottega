import { expect, test } from 'bun:test'
import {
  isReadOnlyRepositoryJob,
  JOBS,
  jobTimeoutCeilingMinutes,
  resolveJobTimeoutMs,
  resolveRecordedRunJob,
} from './jobs.ts'

test('jobs exposes fidelity only for writing jobs', () => {
  expect(JOBS.implement!.needs.writesRepo).toBe(true)
  expect(JOBS.fix!.needs.writesRepo).toBe(true)
  expect(JOBS['review-lens']!.needs.writesRepo).not.toBe(true)
})

test('a read-only repository job reads the repo and does not write it', () => {
  expect(isReadOnlyRepositoryJob('review-lens')).toBe(true)
  expect(isReadOnlyRepositoryJob('understand')).toBe(true)
  expect(isReadOnlyRepositoryJob('implement')).toBe(false)
  expect(isReadOnlyRepositoryJob('summarize')).toBe(false)
  expect(isReadOnlyRepositoryJob('review-lens-inline')).toBe(false)
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

test('recorded run job uses declarations while they exist', () => {
  expect(resolveRecordedRunJob({ job: 'implement', branch: null, minted_branch: null })).toEqual({
    writesRepo: true,
    declared: true,
  })
  expect(
    resolveRecordedRunJob({ job: 'review-lens', branch: 'unexpected', minted_branch: null }),
  ).toEqual({ writesRepo: false, declared: true })
})

test('recorded run job infers retired writers from their recorded branch', () => {
  expect(
    resolveRecordedRunJob({ job: 'retired-writer', branch: null, minted_branch: 'DEV-1400-old' }),
  ).toEqual({ writesRepo: true, declared: false })
  expect(
    resolveRecordedRunJob({ job: 'retired-reader', branch: null, minted_branch: null }),
  ).toEqual({ writesRepo: false, declared: false })
})
