import { describe, expect, test } from 'bun:test'
import {
  readerCloneArchivePruneDecision,
  readerCloneArchiveRetentionDecision,
  readerCloneReleaseDecision,
} from './reader-scratch-release.ts'

const day = 86_400_000

const reader = {
  readOnlyJob: true,
  terminal: true,
  treeAbsent: false,
  provablyDisposable: false,
}

describe('reader clone release decision', () => {
  test('removes only a provably disposable terminal reader clone', () => {
    expect(
      readerCloneReleaseDecision({ ...reader, provablyDisposable: true, archiveSucceeded: null }),
    ).toBe('remove')
  })

  test('archives every terminal reader clone that is not provably disposable', () => {
    expect(readerCloneReleaseDecision({ ...reader, archiveSucceeded: null })).toBe(
      'archive-then-release',
    )
    expect(readerCloneReleaseDecision({ ...reader, archiveSucceeded: true })).toBe('release')
    expect(readerCloneReleaseDecision({ ...reader, archiveSucceeded: false })).toBe('keep')
  })

  test('leaves writing jobs and live readers on the ordinary keep path', () => {
    expect(
      readerCloneReleaseDecision({ ...reader, readOnlyJob: false, archiveSucceeded: null }),
    ).toBe('ordinary')
    expect(readerCloneReleaseDecision({ ...reader, terminal: false, archiveSucceeded: null })).toBe(
      'keep',
    )
  })
})

describe('reader clone archive retention decision', () => {
  test('deletes archives past the configured age and keeps newer archives', () => {
    expect(
      readerCloneArchiveRetentionDecision({
        nowMs: 20 * day,
        modifiedMs: 5 * day,
        retentionDays: 14,
      }),
    ).toBe('delete')
    expect(
      readerCloneArchiveRetentionDecision({
        nowMs: 20 * day,
        modifiedMs: 7 * day,
        retentionDays: 14,
      }),
    ).toBe('keep')
  })

  test('selects the oldest bounded batch and defers the remaining expired archives', () => {
    const result = readerCloneArchivePruneDecision({
      archives: [
        { path: 'newest-expired', archivedMs: 3 * day },
        { path: 'oldest-expired', archivedMs: day },
        { path: 'middle-expired', archivedMs: 2 * day },
      ],
      nowMs: 20 * day,
      retentionDays: 14,
      deletionCap: 2,
    })

    expect(result).toEqual({
      delete: ['oldest-expired', 'middle-expired'],
      deferred: 1,
    })
  })

  test('selects every expired archive when fewer than the cap are expired', () => {
    const result = readerCloneArchivePruneDecision({
      archives: [
        { path: 'older', archivedMs: day },
        { path: 'old', archivedMs: 2 * day },
      ],
      nowMs: 20 * day,
      retentionDays: 14,
      deletionCap: 3,
    })

    expect(result).toEqual({ delete: ['older', 'old'], deferred: 0 })
  })

  test('never selects unexpired archives', () => {
    const result = readerCloneArchivePruneDecision({
      archives: [
        { path: 'expired', archivedMs: day },
        { path: 'unexpired', archivedMs: 19 * day },
      ],
      nowMs: 20 * day,
      retentionDays: 14,
      deletionCap: 2,
    })

    expect(result).toEqual({ delete: ['expired'], deferred: 0 })
  })
})
