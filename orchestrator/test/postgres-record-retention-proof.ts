import { expect, test } from 'bun:test'
import { SQL } from 'bun'
import { newRecordId } from '../../shared/record/schema.ts'
import {
  pruneRecordRetention,
  RECORD_RETENTION_ADVISORY_LOCK_KEY,
} from '../src/record/record-retention.ts'
import { succeeds } from './fixtures/postgres-rls.ts'
import { MACHINE_A, SPACE_A, SPACE_B, USER_A } from './postgres-rls-values.ts'

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
      INSERT INTO contention (id, space_id, machine_id, at, created_at, updated_at, resource_kind, resource_key, event_kind) VALUES
        ('${expiredContentionId}', '${SPACE_A}', '${MACHINE_A}', now() - interval '15 days', now() - interval '15 days', now() - interval '15 days', 'store', 'expired', 'wait'),
        ('${otherSpaceExpiredContentionId}', '${SPACE_B}', '${MACHINE_A}', now() - interval '15 days', now() - interval '15 days', now() - interval '15 days', 'store', 'other-space-expired', 'wait'),
        ('${recentContentionId}', '${SPACE_A}', '${MACHINE_A}', now(), now(), now(), 'store', 'recent', 'wait'),
        ('${otherSpaceRecentContentionId}', '${SPACE_B}', '${MACHINE_A}', now(), now(), now(), 'store', 'other-space-recent', 'wait');
    `)

    const expiredNameplateId = newRecordId()
    const expiredMessageId = newRecordId()
    const liveNameplateId = newRecordId()
    const retentionKeyId = 'RETENTIONPROOFKEY00001'
    const expiredChallengeId = newRecordId()
    const liveChallengeId = newRecordId()
    admin(`
      INSERT INTO machine_join_nameplate
        (id, space_id, nameplate, allocated_by, created_at, expires_at) VALUES
        ('${expiredNameplateId}', '${SPACE_A}', '888881', '${USER_A}', now() - interval '61 minutes', now() - interval '51 minutes'),
        ('${liveNameplateId}', '${SPACE_A}', '888882', '${USER_A}', now(), now() + interval '10 minutes');
      INSERT INTO machine_join_message
        (id, nameplate_id, space_id, side, phase, body, posted_by, created_at) VALUES
        ('${expiredMessageId}', '${expiredNameplateId}', '${SPACE_A}', '11111111111111111111111111111111', 'share', decode('01', 'hex'), '${USER_A}', now() - interval '61 minutes');
      INSERT INTO machine_public_key
        (id, space_id, user_id, key_id, public_key, label, created_at) VALUES
        ('${newRecordId()}', '${SPACE_A}', '${USER_A}', '${retentionKeyId}', decode(repeat('01', 32), 'hex'), 'retention proof', now());
      INSERT INTO machine_key_claim_challenge
        (id, space_id, key_id, user_id, nonce_hash, expires_at, created_at) VALUES
        ('${expiredChallengeId}', '${SPACE_A}', '${retentionKeyId}', '${USER_A}', decode(repeat('02', 32), 'hex'), now() - interval '1 second', now()),
        ('${liveChallengeId}', '${SPACE_A}', '${retentionKeyId}', '${USER_A}', decode(repeat('03', 32), 'hex'), now() + interval '1 hour', now());
    `)

    // pruneRecordRetention connects as record_actor without setting app.space_id or app.user_id.
    const result = await pruneRecordRetention(actorUrl)
    expect(result.acquired).toBe(true)
    if (!result.acquired) throw new Error('record retention lock was unexpectedly unavailable')
    expect(Object.values(result.outcomes).every((outcome) => 'deleted' in outcome)).toBe(true)
    expect(
      'deleted' in result.outcomes.machineJoin && result.outcomes.machineJoin.deleted >= 1,
    ).toBe(true)
    expect(
      'deleted' in result.outcomes.claimChallenge && result.outcomes.claimChallenge.deleted >= 1,
    ).toBe(true)
    expect(
      admin(
        `SELECT count(*) FROM machine_join_nameplate WHERE id='${expiredNameplateId}';
         SELECT count(*) FROM machine_join_message WHERE id='${expiredMessageId}';
         SELECT count(*) FROM machine_join_nameplate WHERE id='${liveNameplateId}';
         SELECT count(*) FROM machine_key_claim_challenge WHERE id='${expiredChallengeId}';
         SELECT count(*) FROM machine_key_claim_challenge WHERE id='${liveChallengeId}';`,
      ),
    ).toBe('0\n0\n1\n0\n1')
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
    admin(`
      DELETE FROM machine_key_claim_challenge WHERE id='${liveChallengeId}';
      DELETE FROM machine_join_nameplate WHERE id='${liveNameplateId}';
      DELETE FROM machine_public_key WHERE space_id='${SPACE_A}' AND key_id='${retentionKeyId}';
    `)
  })
}
