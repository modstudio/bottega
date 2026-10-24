import { describe, expect, test } from 'bun:test'
import { db } from './db.ts'
import {
  assertMigrationDispatchAllowed,
  migrationDrain,
  migrationDrainForUpdate,
  migrationDrainLiveness,
  setMigrationDrain,
} from './migration-drain.ts'

const marker = {
  migration: '0155_rebuild',
  phase: 'draining' as const,
  pid: 4321,
  startTime: 'recorded birth',
}

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

  test("reclaiming a dead holder's marker records contention on the reclaim handle", () => {
    setMigrationDrain(db(), marker.migration, 'draining', marker)
    expect(
      migrationDrainForUpdate(db(), {
        pidAlive: () => false,
        processStartTime: () => 'unused',
      }),
    ).toBeNull()
    expect(migrationDrain(db())).toBeNull()
    expect(
      db()
        .query(
          "SELECT resource_kind,resource_key,event_kind,cause FROM contention WHERE resource_key='migration-drain' ORDER BY at DESC, record_id DESC LIMIT 1",
        )
        .get(),
    ).toEqual({
      resource_kind: 'store',
      resource_key: 'migration-drain',
      event_kind: 'invalidation',
      cause: expect.stringContaining('dead holder pid 4321'),
    })
  })

  test('a reclaim never removes a marker that replaced the one it judged stale', () => {
    setMigrationDrain(db(), marker.migration, 'draining', marker)
    const replacement = { ...marker, pid: process.pid, startTime: 'replacement birth' }
    const current = migrationDrainForUpdate(db(), {
      pidAlive: () => {
        // Another update reclaims the stale marker and installs its own before
        // this reclaim deletes.
        db()
          .query("UPDATE schema_meta SET value=? WHERE key='migration_drain'")
          .run(JSON.stringify(replacement))
        return false
      },
      processStartTime: () => 'unused',
    })
    try {
      expect(current).toEqual(replacement)
      expect(migrationDrain(db())).toEqual(replacement)
    } finally {
      db().query("DELETE FROM schema_meta WHERE key='migration_drain'").run()
    }
  })

  test('a live marker refuses a new chain but admits a resume', () => {
    setMigrationDrain(db(), marker.migration, 'draining', {
      pid: process.pid,
      startTime: null,
    })
    try {
      expect(() => assertMigrationDispatchAllowed(db())).toThrow(/refusing dispatch.*re-dispatch/)
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

  test('a migrating marker refuses a resume', () => {
    setMigrationDrain(db(), marker.migration, 'migrating', {
      pid: process.pid,
      startTime: null,
    })
    try {
      expect(() => assertMigrationDispatchAllowed(db(), true)).toThrow(/while migrating/)
    } finally {
      db().query("DELETE FROM schema_meta WHERE key='migration_drain'").run()
    }
  })
})
