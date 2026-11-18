import { describe, expect, test } from 'bun:test'
import { hostedRecordSnapshotKey } from './hosted-record-snapshot.ts'

const migrationFiles = [
  { name: '0001/migration.sql', contents: new TextEncoder().encode('SELECT 1;') },
  { name: '0002/migration.sql', contents: new TextEncoder().encode('SELECT 2;') },
]

describe('hosted record snapshot key', () => {
  test('changes with migration bytes and the PGlite version', () => {
    const original = hostedRecordSnapshotKey(migrationFiles, '1.0.0')
    const changedMigration = migrationFiles.map((file) => ({ ...file }))
    changedMigration[1] = {
      ...changedMigration[1]!,
      contents: new TextEncoder().encode('SELECT 3;'),
    }

    expect(hostedRecordSnapshotKey(changedMigration, '1.0.0')).not.toBe(original)
    expect(hostedRecordSnapshotKey(migrationFiles, '1.0.1')).not.toBe(original)
  })
})
