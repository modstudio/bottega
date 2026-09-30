import { describe, expect, test } from 'bun:test'
import { chooseBranchLandingTip, verifyBranchLanding } from './branch-landing-record.ts'

const mergedPullRequest = {
  number: 190,
  state: 'MERGED',
  title: 'DEV-617 remove unneeded exports',
  headRefName: 'DEV-617-remove',
  headRefOid: 'def456',
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
      reason: 'PR #190 carries task key neither in its title nor in its head branch: DEV-602',
    })
  })

  test('refuses a title that only contains the key as a prefix of a longer key', () => {
    expect(verifyBranchLanding('DEV-61', mergedPullRequest)).toEqual({
      accepted: false,
      reason: 'PR #190 carries task key neither in its title nor in its head branch: DEV-61',
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

  test('accepts a merged pull request whose head branch contains the run task key', () => {
    expect(
      verifyBranchLanding('DEV-617', {
        ...mergedPullRequest,
        title: 'remove unneeded exports',
        headRefName: 'DEV-617-remove',
      }),
    ).toEqual({
      accepted: true,
      landing: {
        number: 190,
        mergeCommit: 'abc123',
        mergedAt: '2026-09-16T12:00:00Z',
      },
    })
  })
})

describe('branch landing tip choice', () => {
  test('uses the local tip when only it is available', () => {
    expect(chooseBranchLandingTip('local123', null)).toEqual({
      accepted: true,
      tip: 'local123',
      source: 'local',
      differsFromPrHead: false,
    })
  })

  test('uses the local tip when both tips are equal', () => {
    expect(chooseBranchLandingTip('same123', 'same123')).toEqual({
      accepted: true,
      tip: 'same123',
      source: 'local',
      differsFromPrHead: false,
    })
  })

  test('uses the pull request head when the local tip is missing', () => {
    expect(chooseBranchLandingTip(null, 'head123')).toEqual({
      accepted: true,
      tip: 'head123',
      source: 'pull-request',
      differsFromPrHead: false,
    })
  })

  test('refuses when neither tip is available', () => {
    expect(chooseBranchLandingTip(null, null)).toEqual({ accepted: false })
  })

  test('keeps and marks a local tip that differs from the pull request head', () => {
    expect(chooseBranchLandingTip('local123', 'head123')).toEqual({
      accepted: true,
      tip: 'local123',
      source: 'local',
      differsFromPrHead: true,
    })
  })
})
