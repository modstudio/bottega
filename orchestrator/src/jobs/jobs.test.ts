import { expect, test } from 'bun:test'
import { DEFAULT_EXTERNAL_WAIT_IDLE_KILL_MS } from '../idle-kill.ts'
import {
  isReadOnlyRepositoryJob,
  JOBS,
  jobIdleKillMs,
  jobTimeoutCeilingMinutes,
  REVIEW_LENS_IDLE_KILL_MS,
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

test('jobIdleKillMs picks env over job over default and still clamps', () => {
  expect(JOBS['review-lens']!.idleKillMs).toBe(REVIEW_LENS_IDLE_KILL_MS)
  expect(JOBS.implement!.idleKillMs).toBeUndefined()
  expect(jobIdleKillMs('review-lens', {})).toBe(REVIEW_LENS_IDLE_KILL_MS)
  expect(jobIdleKillMs('implement', {})).toBe(DEFAULT_EXTERNAL_WAIT_IDLE_KILL_MS)
  expect(jobIdleKillMs('review-lens', { BOTTEGA_IDLE_KILL_MS: '120000' })).toBe(120_000)
  expect(jobIdleKillMs('review-lens', { BOTTEGA_IDLE_KILL_MS: '3600000' }, 30 * 60_000)).toBe(
    29 * 60_000,
  )
  expect(jobIdleKillMs('unknown-job', {})).toBe(DEFAULT_EXTERNAL_WAIT_IDLE_KILL_MS)
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
