import { describe, expect, test } from 'bun:test'
import { decideMigrationDrain } from './migration-drain-decision.ts'

const journal = [
  { idx: 0, when: 1, tag: '0000_base' },
  { idx: 1, when: 2, tag: '0001_additive', compatibility: 'additive' as const },
  { idx: 2, when: 3, tag: '0002_rebuild' },
]
describe('migration drain decision', () => {
  test('applies an empty range', () => {
    expect(
      decideMigrationDrain({
        journal,
        storeVersion: 3,
      }),
    ).toEqual({ action: 'apply-now' })
  })

  test('applies an additive range with runs in flight', () => {
    expect(
      decideMigrationDrain({
        journal: journal.slice(0, 2),
        storeVersion: 1,
      }),
    ).toEqual({ action: 'apply-now' })
  })

  test('fences a non-additive range even with no runs', () => {
    expect(
      decideMigrationDrain({
        journal,
        storeVersion: 2,
      }),
    ).toEqual({ action: 'fence', migration: '0002_rebuild' })
  })
})
