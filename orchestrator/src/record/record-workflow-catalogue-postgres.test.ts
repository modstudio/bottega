import { beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { newRecordId } from '../../../shared/record/schema.ts'
import { migratePostgres } from '../postgres/postgres-migrate.ts'
import {
  draftRecordWorkflow,
  promoteRecordWorkflow,
  retireRecordWorkflow,
} from './record-workflow-catalogue.ts'

const url = process.env.ORCH_TEST_WORKFLOW_CATALOGUE_URL
const postgres = url ? describe : describe.skip
const spaceId = newRecordId(),
  userId = newRecordId()
const tenant = () => ({ url: url!, spaceId, spaceIds: [spaceId], userId })

postgres('hosted workflow catalogue compare-and-set writers', () => {
  beforeAll(async () => {
    await migratePostgres(url)
    const sql = new SQL(url!)
    try {
      await sql`INSERT INTO space (id,name,slug,created_at) VALUES (${spaceId}::uuid,${`Workflow CAS ${spaceId}`},${`workflow-${spaceId}`},now())`
    } finally {
      await sql.close()
    }
  })

  test('stale promote and retire refuse with 409 and leave the transaction unchanged', async () => {
    const context = { ...tenant(), author: 'test', reason: 'test', sessionId: null }
    await draftRecordWorkflow({
      ...context,
      kind: 'workflow',
      slug: 'cas-flow',
      event: 'set',
      definition: '{}',
    })
    await promoteRecordWorkflow({
      ...context,
      kind: 'workflow',
      slug: 'cas-flow',
      n: 1,
      expectedProductionVersion: null,
    })
    await draftRecordWorkflow({
      ...context,
      kind: 'workflow',
      slug: 'cas-flow',
      event: 'set',
      definition: '{}',
    })
    await expect(
      promoteRecordWorkflow({
        ...context,
        kind: 'workflow',
        slug: 'cas-flow',
        n: 2,
        expectedProductionVersion: null,
      }),
    ).rejects.toMatchObject({ status: 409 })
    await expect(
      retireRecordWorkflow({
        ...context,
        kind: 'workflow',
        slug: 'cas-flow',
        n: 1,
        expectedProductionVersion: null,
      }),
    ).rejects.toMatchObject({ status: 409 })
    const sql = new SQL(url!)
    try {
      const rows =
        await sql`SELECT n,status FROM workflow_version WHERE space_id=${spaceId}::uuid ORDER BY n`
      const [count] =
        await sql`SELECT count(*)::integer n FROM workflow_event WHERE space_id=${spaceId}::uuid`
      expect(rows).toEqual([
        { n: 1, status: 'production' },
        { n: 2, status: 'draft' },
      ])
      expect(count).toEqual({ n: 3 })
    } finally {
      await sql.close()
    }
  })
})
