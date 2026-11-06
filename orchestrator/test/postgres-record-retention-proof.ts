import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import {
  pruneRecordRetention,
  RECORD_RETENTION_ADVISORY_LOCK_KEY,
} from '../src/record/record-retention.ts'
import { succeeds } from './fixtures/postgres-rls.ts'
import { MACHINE_A, SPACE_A, SPACE_B } from './postgres-rls-values.ts'

export function registerRecordRetentionProof(actorUrl: string): void {
  const admin = (statement: string) => succeeds('postgres', 'postgres', statement)
  test('the record API role prunes expired changes and contention and skips while another instance holds the lock', async () => {
    const expiredRowId = newRecordId()
    const recentRowId = newRecordId()
    admin(`
      INSERT INTO record_change (space_id, table_name, row_id, op, at) VALUES
        ('${SPACE_A}', 'project', '${expiredRowId}', 'upsert', now() - interval '31 days'),
        ('${SPACE_A}', 'project', '${recentRowId}', 'upsert', now());
    `)

    const expiredContentionId = newRecordId()
    const otherSpaceExpiredContentionId = newRecordId()
    const recentContentionId = newRecordId()
    const otherSpaceRecentContentionId = newRecordId()
    admin(`
      INSERT INTO contention (id, space_id, machine_id, at, resource_kind, resource_key, event_kind) VALUES
        ('${expiredContentionId}', '${SPACE_A}', '${MACHINE_A}', now() - interval '15 days', 'store', 'expired', 'wait'),
        ('${otherSpaceExpiredContentionId}', '${SPACE_B}', '${MACHINE_A}', now() - interval '15 days', 'store', 'other-space-expired', 'wait'),
        ('${recentContentionId}', '${SPACE_A}', '${MACHINE_A}', now(), 'store', 'recent', 'wait'),
        ('${otherSpaceRecentContentionId}', '${SPACE_B}', '${MACHINE_A}', now(), 'store', 'other-space-recent', 'wait');
    `)

    // pruneRecordRetention connects as record_actor without setting app.space_id or app.user_id.
    expect((await pruneRecordRetention(actorUrl)).acquired).toBe(true)
    expect(
      admin(
        `SELECT row_id FROM record_change WHERE row_id IN ('${expiredRowId}', '${recentRowId}') ORDER BY row_id;`,
      ),
    ).toBe(recentRowId)
    expect(
      admin(
        `SELECT resource_key FROM contention
         WHERE id IN ('${expiredContentionId}', '${otherSpaceExpiredContentionId}', '${recentContentionId}', '${otherSpaceRecentContentionId}')
         ORDER BY resource_key;`,
      ),
    ).toBe('other-space-recent\nrecent')

    const holder = new SQL(actorUrl)
    let announceLock!: () => void
    const lockHeld = new Promise<void>((resolve) => (announceLock = resolve))
    let releaseLock!: () => void
    const released = new Promise<void>((resolve) => (releaseLock = resolve))
    const transaction = holder.begin(async (tx) => {
      const rows = (await tx`
        SELECT pg_try_advisory_lock(${RECORD_RETENTION_ADVISORY_LOCK_KEY}) AS acquired
      `) as Array<{ acquired: boolean }>
      expect(rows[0]?.acquired).toBe(true)
      announceLock()
      await released
    })

    await lockHeld
    const lockedRowId = newRecordId()
    admin(`
      INSERT INTO record_change (space_id, table_name, row_id, op, at)
      VALUES ('${SPACE_A}', 'project', '${lockedRowId}', 'upsert', now() - interval '31 days');
    `)
    try {
      expect(await pruneRecordRetention(actorUrl)).toEqual({ acquired: false })
      expect(admin(`SELECT count(*) FROM record_change WHERE row_id = '${lockedRowId}';`)).toBe('1')
    } finally {
      releaseLock()
      await transaction
      await holder.close()
    }
  })
}
