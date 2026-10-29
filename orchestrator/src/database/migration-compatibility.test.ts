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
      reason:
        "store migrated from version 145 to 147 past this process's version; restart this process, and re-dispatch any run it was coordinating",
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
    expect(
      inFlightMigrationCompatibility(
        [...entries, { idx: 3, when: 4, tag: '0003', compatibility: 'future-token' }],
        3,
        4,
      ),
    ).toBe('incompatible')
  })

  test('a range past an all-additive journal is incompatible', () => {
    const entries = [
      { idx: 0, when: 1, tag: '0000', compatibility: 'additive' as const },
      { idx: 1, when: 2, tag: '0001', compatibility: 'additive' as const },
    ]
    expect(inFlightMigrationCompatibility(entries, entries.length, entries.length + 2)).toBe(
      'incompatible',
    )
  })

  test('new journal entries must declare non-empty compatibility metadata', () => {
    const legacy = Array.from({ length: 181 }, (_, idx) => ({ idx, when: idx, tag: `${idx}` }))
    expect(() =>
      validatedMigrationJournalEntries([...legacy, { idx: 181, when: 181, tag: '0181_missing' }]),
    ).toThrow("migration 0181_missing must declare compatibility as 'additive' or 'fenced'")
    expect(
      validatedMigrationJournalEntries([
        ...legacy,
        { idx: 181, when: 181, tag: '0181_additive', compatibility: 'additive' },
        { idx: 182, when: 182, tag: '0182_fenced', compatibility: 'fenced' },
      ]).slice(-2),
    ).toEqual([
      { idx: 181, when: 181, tag: '0181_additive', compatibility: 'additive' },
      { idx: 182, when: 182, tag: '0182_fenced', compatibility: 'fenced' },
    ])
    expect(
      validatedMigrationJournalEntries([
        ...legacy,
        { idx: 181, when: 181, tag: '0181_future', compatibility: 'future-token' },
      ]).at(-1),
    ).toEqual({ idx: 181, when: 181, tag: '0181_future', compatibility: 'future-token' })
    expect(() =>
      validatedMigrationJournalEntries([
        ...legacy,
        { idx: 181, when: 181, tag: '0181_empty', compatibility: '' },
      ]),
    ).toThrow('invalid migration compatibility for 0181_empty: expected a non-empty string')
    expect(() =>
      validatedMigrationJournalEntries([
        ...legacy,
        { idx: 181, when: 181, tag: '0181_non_string', compatibility: 1 },
      ]),
    ).toThrow('invalid migration compatibility for 0181_non_string: expected a non-empty string')
  })
})
