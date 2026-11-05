import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import type { InstallationIdentity } from '../../../shared/install-root.ts'
import type { MigrationJournalEntry } from '../database/migration-compatibility.ts'
import {
  MACHINE_JOURNAL_SCHEMA,
  MACHINE_JOURNAL_SCHEMA_VERSION,
  shapeMachineJournal,
} from './machine-journal.ts'

const distribution: InstallationIdentity = {
  kind: 'distribution',
  root: '/opt/workshop',
  manifest: {
    name: PLATFORM_NAME,
    version: '0.5.0',
    commit: 'abc1234',
    built: '2026-11-05T12:00:00.000Z',
  },
}

const checkout: InstallationIdentity = {
  kind: 'checkout',
  root: '/src/workshop',
  version: '0.5.1',
}

test.each([
  {
    identity: distribution,
    expected: {
      kind: 'distribution',
      root: '/opt/workshop',
      version: '0.5.0',
      commit: 'abc1234',
      built: '2026-11-05T12:00:00.000Z',
    },
  },
  { identity: checkout, expected: checkout },
])('shapes and validates a $identity.kind installation journal', ({ identity, expected }) => {
  const entries: MigrationJournalEntry[] = [
    { idx: 0, when: 1_700_000_000_000, tag: '0000_x' },
    { idx: 1, when: 1_700_000_000_001, tag: '0001_y', compatibility: 'additive' },
  ]
  const expectedEntries = entries.map((entry) => ({
    idx: entry.idx,
    when: entry.when,
    tag: entry.tag,
    compatibility: entry.compatibility ?? null,
  }))

  const result = shapeMachineJournal(identity, entries)

  expect(result).toEqual({
    schemaVersion: MACHINE_JOURNAL_SCHEMA_VERSION,
    installation: expected,
    orchestratorJournal: expectedEntries,
  })
  expect(MACHINE_JOURNAL_SCHEMA.parse(result)).toEqual(result)
  expect(result.orchestratorJournal).toHaveLength(entries.length)
  for (const [index, entry] of entries.entries()) {
    expect(result.orchestratorJournal[index]).toEqual({
      ...entry,
      compatibility: entry.compatibility ?? null,
    })
  }
})
