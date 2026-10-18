import { beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import { migratePostgres } from '../postgres/postgres-migrate.ts'
import { writeRecordPort } from './record-port-catalogue.ts'

const url = process.env.ORCH_TEST_PORT_CATALOGUE_URL
const postgres = url ? describe : describe.skip
const spaceId = newRecordId()
const userId = newRecordId()
const sourceProjectId = newRecordId()
const targetProjectId = newRecordId()
const tenant = () => ({ url: url!, spaceId, spaceIds: [spaceId], userId })

postgres('hosted port compare-and-set writers', () => {
  beforeAll(async () => {
    await migratePostgres(url)
    const sql = new SQL(url!)
    try {
      await sql`INSERT INTO space (id,name,slug,created_at) VALUES (${spaceId}::uuid,${`Port CAS ${spaceId}`},${`port-${spaceId}`},now())`
      await sql`INSERT INTO project (id,space_id,name,path,stack,canon,settings,created_at,updated_at) VALUES (${sourceProjectId}::uuid,${spaceId}::uuid,'source','/source',NULL,false,'{}',now(),now()),(${targetProjectId}::uuid,${spaceId}::uuid,'target','/target',NULL,false,'{}',now(),now())`
    } finally {
      await sql.close()
    }
  })

  test('a stale baseline update returns 409 through the real hosted writer', async () => {
    const input = {
      ...tenant(),
      action: 'set_baseline' as const,
      sourceProjectId,
      targetProjectId,
      sourceCommit: 'one',
      scannedAt: '2026-10-18T12:00:00.000Z',
      expectedVersion: null,
    }
    await writeRecordPort(input)
    await writeRecordPort({ ...input, sourceCommit: 'two', expectedVersion: 1 })
    await expect(
      writeRecordPort({ ...input, sourceCommit: 'stale', expectedVersion: 1 }),
    ).rejects.toMatchObject({ status: 409 })
  })
})
