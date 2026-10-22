import { describe, expect, test } from 'bun:test'
import {
  decideInFlightMigration,
  inFlightMigrationCompatibility,
  validatedMigrationJournalEntries,
} from './migration-compatibility.ts'

describe('in-flight migration compatibility', () => {
  test('keeps a coordinator running only across a forward additive migration', () => {
    expect(
      decideInFlightMigration({
        processJournalVersion: 145,
        storeVersion: 146,
        migrationCompatibility: 'additive',
      }),
    ).toEqual({ action: 'keep-going' })
  })

  test('names the migrated store version when compatibility is not established', () => {
    expect(
      decideInFlightMigration({
        processJournalVersion: 145,
        storeVersion: 147,
        migrationCompatibility: 'incompatible',
      }),
    ).toEqual({
      action: 'fail',
      reason: 'store migrated to version 147 while this run was in flight; re-dispatch it',
    })
  })

  test('a range is additive only when every expected journal entry says so', () => {
    const entries = [
      { idx: 0, when: 1, tag: '0000' },
      { idx: 1, when: 2, tag: '0001', compatibility: 'additive' as const },
      { idx: 2, when: 3, tag: '0002' },
    ]
    expect(inFlightMigrationCompatibility(entries, 1, 2)).toBe('additive')
    expect(inFlightMigrationCompatibility(entries, 1, 3)).toBe('incompatible')
    expect(inFlightMigrationCompatibility(entries, 2, 4)).toBe('incompatible')
  })

  test('journal validation refuses an unknown compatibility label at the edge', () => {
    expect(() =>
      validatedMigrationJournalEntries([
        { idx: 0, when: 1, tag: '0000', compatibility: 'breaking' as 'additive' },
      ]),
    ).toThrow('invalid migration compatibility for 0000')
  })
})
