import { describe, expect, test } from 'bun:test'
import {
  readerCloneArchiveRetentionDecision,
  readerCloneReleaseDecision,
} from './reader-scratch-release.ts'

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
    const day = 86_400_000
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
})
