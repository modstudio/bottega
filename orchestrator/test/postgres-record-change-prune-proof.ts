import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import {
  pruneRecordChanges,
  RECORD_CHANGE_PRUNE_ADVISORY_LOCK_KEY,
} from '../src/record/record-change-prune.ts'
import { succeeds } from './fixtures/postgres-rls.ts'
import { SPACE_A } from './postgres-rls-values.ts'

export function registerRecordChangePruneProof(actorUrl: string): void {
  const admin = (statement: string) => succeeds('postgres', 'postgres', statement)
  test('the record API role prunes expired changes and skips while another instance holds the lock', async () => {
    const expiredRowId = newRecordId()
    const recentRowId = newRecordId()
    admin(`
      INSERT INTO record_change (space_id, table_name, row_id, op, at) VALUES
        ('${SPACE_A}', 'project', '${expiredRowId}', 'upsert', now() - interval '31 days'),
        ('${SPACE_A}', 'project', '${recentRowId}', 'upsert', now());
    `)

    expect((await pruneRecordChanges(actorUrl)).acquired).toBe(true)
    expect(
      admin(
        `SELECT row_id FROM record_change WHERE row_id IN ('${expiredRowId}', '${recentRowId}') ORDER BY row_id;`,
      ),
    ).toBe(recentRowId)

    const holder = new SQL(actorUrl)
    let announceLock!: () => void
    const lockHeld = new Promise<void>((resolve) => (announceLock = resolve))
    let releaseLock!: () => void
    const released = new Promise<void>((resolve) => (releaseLock = resolve))
    const transaction = holder.begin(async (tx) => {
      const rows = (await tx`
        SELECT pg_try_advisory_xact_lock(${RECORD_CHANGE_PRUNE_ADVISORY_LOCK_KEY}) AS acquired
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
      expect(await pruneRecordChanges(actorUrl)).toEqual({ acquired: false })
      expect(admin(`SELECT count(*) FROM record_change WHERE row_id = '${lockedRowId}';`)).toBe('1')
    } finally {
      releaseLock()
      await transaction
      await holder.close()
    }
  })
}
