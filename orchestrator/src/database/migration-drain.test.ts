import { describe, expect, test } from 'bun:test'
import { db } from './db.ts'
import {
  assertMigrationDispatchAllowed,
  migrationDrain,
  migrationDrainForUpdate,
  migrationDrainLiveness,
  setMigrationDrain,
} from './migration-drain.ts'

const marker = { migration: '0155_rebuild', pid: 4321, startTime: 'recorded birth' }

describe('migration drain holder', () => {
  test('classifies stale, live, and unknown process identities', () => {
    expect(
      migrationDrainLiveness(marker, {
        pidAlive: () => false,
        processStartTime: () => 'unused',
      }),
    ).toEqual({ state: 'stale', reason: 'dead holder pid 4321' })
    expect(
      migrationDrainLiveness(marker, {
        pidAlive: () => true,
        processStartTime: () => 'recorded birth',
      }),
    ).toEqual({ state: 'live' })
    expect(
      migrationDrainLiveness(marker, {
        pidAlive: () => true,
        processStartTime: () => null,
      }),
    ).toEqual({ state: 'unknown', reason: 'holder pid 4321 start time is unavailable' })
  })

  test("reclaiming a dead holder's marker records contention", () => {
    setMigrationDrain(db(), marker.migration, marker)
    const recorded: unknown[] = []
    expect(
      migrationDrainForUpdate(
        db(),
        { pidAlive: () => false, processStartTime: () => 'unused' },
        (contention) => {
          recorded.push(contention)
        },
      ),
    ).toBeNull()
    expect(migrationDrain(db())).toBeNull()
    expect(recorded).toEqual([
      expect.objectContaining({
        resourceKind: 'store',
        resourceKey: 'migration-drain',
        eventKind: 'invalidation',
        cause: expect.stringContaining('dead holder pid 4321'),
      }),
    ])
  })

  test('a live marker refuses a new chain but admits a resume', () => {
    setMigrationDrain(db(), marker.migration, { pid: process.pid, startTime: null })
    try {
      expect(() => assertMigrationDispatchAllowed(db())).toThrow(
        /refusing new dispatch.*re-dispatch/,
      )
      expect(() => assertMigrationDispatchAllowed(db(), true)).not.toThrow()
      expect(
        db()
          .query(
            "SELECT event_kind FROM contention WHERE resource_kind='store' AND resource_key='migration-drain' ORDER BY at DESC, record_id DESC LIMIT 1",
          )
          .get(),
      ).toEqual({ event_kind: 'refusal' })
    } finally {
      db().query("DELETE FROM schema_meta WHERE key='migration_drain'").run()
    }
  })
})
