import { describe, expect, test } from 'bun:test'
import { verifyBranchLanding } from './branch-landing-record.ts'

const mergedPullRequest = {
  number: 190,
  state: 'MERGED',
  title: 'DEV-617 remove unneeded exports',
  mergeCommit: { oid: 'abc123' },
  mergedAt: '2026-09-16T12:00:00Z',
}

describe('branch landing record verification', () => {
  test('refuses a pull request that is not merged', () => {
    expect(verifyBranchLanding('DEV-617', { ...mergedPullRequest, state: 'OPEN' })).toEqual({
      accepted: false,
      reason: 'PR #190 is not merged',
    })
  })

  test('refuses a pull request whose title lacks the run task key', () => {
    expect(
      verifyBranchLanding('DEV-602', {
        ...mergedPullRequest,
        title: 'DEV-617 remove unneeded exports',
      }),
    ).toEqual({
      accepted: false,
      reason: 'PR #190 title does not contain task key DEV-602',
    })
  })

  test('accepts a merged pull request whose title contains the run task key', () => {
    expect(verifyBranchLanding('DEV-617', mergedPullRequest)).toEqual({
      accepted: true,
      landing: {
        number: 190,
        mergeCommit: 'abc123',
        mergedAt: '2026-09-16T12:00:00Z',
      },
    })
  })
})
