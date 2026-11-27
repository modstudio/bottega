import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import { migratePostgres } from '../postgres/postgres-migrate.ts'
import { addDataKeyWraps, createDataKey } from './record-config.ts'
import { closeRecordPools } from './record-pool.ts'

const url = process.env.BOTTEGA_TEST_RECORD_CONFIG_WRAPS_URL
const realPostgres = url ? describe : describe.skip
const spaceId = newRecordId()
const userId = newRecordId()
const dekId = newRecordId()
const recipientKeyId = 'AAAAAAAAAAAAAAAAAAAAAA'
const senderKeyId = 'BBBBBBBBBBBBBBBBBBBBBB'
const tenant = () => ({ url: url!, spaceId, spaceIds: [spaceId], userId })

afterAll(closeRecordPools)

realPostgres('record config wraps against real Postgres', () => {
  beforeAll(async () => {
    await migratePostgres(url)
    const sql = new SQL(url!)
    try {
      await sql`INSERT INTO space (id,name,slug,created_at) VALUES (${spaceId}::uuid,${`Wrap test ${spaceId}`},${`wrap-test-${spaceId}`},now())`
      await sql`INSERT INTO "user" (id,email,name,email_verified,created_at,updated_at) VALUES (${userId}::uuid,${`wrap-${userId}@example.test`},'Wrap test',true,now(),now())`
      await sql`INSERT INTO membership (id,space_id,user_id,role,permission,config_access,created_at) VALUES (${newRecordId()}::uuid,${spaceId}::uuid,${userId}::uuid,'owner','write',true,now())`
      await sql`
        INSERT INTO machine_public_key
          (id,space_id,user_id,key_id,public_key,label,created_at)
        VALUES
          (${newRecordId()}::uuid,${spaceId}::uuid,${userId}::uuid,${recipientKeyId},${new Uint8Array(32)},'recipient',now()),
          (${newRecordId()}::uuid,${spaceId}::uuid,${userId}::uuid,${senderKeyId},${new Uint8Array(32)},'sender',now())
      `
    } finally {
      await sql.close()
    }
  })

  test('adding the same wrap twice inserts one row', async () => {
    await createDataKey({ ...tenant(), dekId, version: 1, wraps: [] })
    const wrap = {
      recipientKeyId,
      senderKeyId,
      enc: new Uint8Array([1, 2, 3]),
      ciphertext: new Uint8Array([4, 5, 6]),
    }

    expect(await addDataKeyWraps({ ...tenant(), dekId, wraps: [wrap] })).toBe(1)
    expect(await addDataKeyWraps({ ...tenant(), dekId, wraps: [wrap] })).toBe(0)

    const sql = new SQL(url!)
    try {
      const rows = await sql`
        SELECT count(*)::int AS count FROM secret_dek_wrap
        WHERE space_id=${spaceId}::uuid AND dek_id=${dekId}::uuid
          AND recipient_key_id=${recipientKeyId} AND sender_key_id=${senderKeyId}
      `
      expect(rows[0]?.count).toBe(1)
    } finally {
      await sql.close()
    }
  })
})
