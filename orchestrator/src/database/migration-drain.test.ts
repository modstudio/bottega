import { describe, expect, test } from 'bun:test'
import { db } from './db.ts'
import {
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
})
