import { beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { Hono } from 'hono'
import { newRecordId } from '../../../shared/record/schema.ts'
import { migratePostgres } from '../postgres/postgres-migrate.ts'
import { registerRecordWorkflowRoutes } from './record-api-workflow.ts'
import type { RecordIdentity } from './record-auth.ts'
import {
  draftRecordWorkflow,
  listRecordWorkflowCatalogue,
  promoteRecordWorkflow,
  retireRecordWorkflow,
} from './record-workflow-catalogue.ts'

const url = process.env.ORCH_TEST_WORKFLOW_CATALOGUE_URL
const postgres = url ? describe : describe.skip
const spaceId = newRecordId(),
  pagingSpaceId = newRecordId(),
  userId = newRecordId()
const tenant = () => ({ url: url!, spaceId, spaceIds: [spaceId], userId })

postgres('hosted workflow catalogue compare-and-set writers', () => {
  beforeAll(async () => {
    await migratePostgres(url)
    const sql = new SQL(url!)
    try {
      await sql`INSERT INTO space (id,name,slug,created_at) VALUES (${spaceId}::uuid,${`Workflow CAS ${spaceId}`},${`workflow-${spaceId}`},now())`
      await sql`INSERT INTO space (id,name,slug,created_at) VALUES (${pagingSpaceId}::uuid,${`Workflow paging ${pagingSpaceId}`},${`workflow-paging-${pagingSpaceId}`},now())`
    } finally {
      await sql.close()
    }
  })

  test('pages rows sharing one transaction timestamp exactly once and terminates', async () => {
    const ids = Array.from({ length: 5 }, () => newRecordId())
    const sql = new SQL(url!)
    try {
      await sql.begin(async (tx) => {
        for (const [index, id] of ids.entries())
          await tx`INSERT INTO workflow (id,space_id,slug,generation,created_at,updated_at) VALUES (${id}::uuid,${pagingSpaceId}::uuid,${`page-${index}`},1,now(),now())`
      })
    } finally {
      await sql.close()
    }

    const seen: string[] = []
    const app = new Hono<{
      Variables: { identity: RecordIdentity; destinationSpaceId?: string }
    }>()
    registerRecordWorkflowRoutes(
      app,
      {
        listWorkflowCatalogue: listRecordWorkflowCatalogue,
        draftWorkflow: async () => null,
        promoteWorkflow: async () => null,
        retireWorkflow: async () => null,
      },
      { scope: () => ({ ...tenant(), spaceId: pagingSpaceId }), noSpace: () => new Response() },
    )
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const response = await app.request(
        `/v1/workflow-catalogue/workflow?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      )
      const page = (await response.json()) as {
        items: { id: string }[]
        nextCursor: string | null
      }
      pages++
      seen.push(...page.items.map((item) => item.id))
      if (!page.nextCursor) break
      cursor = page.nextCursor
      expect(pages).toBeLessThan(4)
    }
    expect(pages).toBe(3)
    expect(new Set(seen)).toEqual(new Set(ids))
    expect(seen).toHaveLength(ids.length)
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
