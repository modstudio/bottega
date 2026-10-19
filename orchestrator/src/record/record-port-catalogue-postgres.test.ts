import { beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { Hono } from 'hono'
import { newRecordId } from '../../../shared/record/schema.ts'
import { migratePostgres } from '../postgres/postgres-migrate.ts'
import { registerRecordPortRoutes } from './record-api-port.ts'
import type { RecordIdentity } from './record-auth.ts'
import { listRecordPortCatalogue, writeRecordPort } from './record-port-catalogue.ts'
import { type RecordPortTable, recordPortPageSchema } from './record-port-contract.ts'

const url = process.env.ORCH_TEST_PORT_CATALOGUE_URL
const postgres = url ? describe : describe.skip
const spaceId = newRecordId()
const pagingSpaceId = newRecordId()
const userId = newRecordId()
const sourceProjectId = newRecordId()
const targetProjectId = newRecordId()
const pagingSourceProjectId = newRecordId()
const pagingTargetProjectId = newRecordId()
const pagingPairId = newRecordId()
const tenant = () => ({ url: url!, spaceId, spaceIds: [spaceId], userId })

postgres('hosted port compare-and-set writers', () => {
  beforeAll(async () => {
    await migratePostgres(url)
    const sql = new SQL(url!)
    try {
      await sql`INSERT INTO space (id,name,slug,created_at) VALUES (${spaceId}::uuid,${`Port CAS ${spaceId}`},${`port-${spaceId}`},now())`
      await sql`INSERT INTO space (id,name,slug,created_at) VALUES (${pagingSpaceId}::uuid,${`Port paging ${pagingSpaceId}`},${`port-paging-${pagingSpaceId}`},now())`
      await sql`INSERT INTO project (id,space_id,name,created_at) VALUES (${sourceProjectId}::uuid,${spaceId}::uuid,'source',now()),(${targetProjectId}::uuid,${spaceId}::uuid,'target',now())`
      await sql`INSERT INTO project (id,space_id,name,created_at) VALUES (${pagingSourceProjectId}::uuid,${pagingSpaceId}::uuid,'paging-source',now()),(${pagingTargetProjectId}::uuid,${pagingSpaceId}::uuid,'paging-target',now())`
    } finally {
      await sql.close()
    }
  })

  test('pages port rows sharing one transaction timestamp exactly once and terminates', async () => {
    const ids = Array.from({ length: 5 }, () => newRecordId())
    const sql = new SQL(url!)
    try {
      await sql.begin(async (tx) => {
        await tx`INSERT INTO port_pair (id,space_id,source_project_id,target_project_id,created_at) VALUES (${pagingPairId}::uuid,${pagingSpaceId}::uuid,${pagingSourceProjectId}::uuid,${pagingTargetProjectId}::uuid,now())`
        for (const [index, id] of ids.entries())
          await tx`INSERT INTO port_skip (id,space_id,pair_id,candidate,reason,skipped_at) VALUES (${id}::uuid,${pagingSpaceId}::uuid,${pagingPairId}::uuid,${`candidate-${index}`},'paging proof',now())`
      })
    } finally {
      await sql.close()
    }

    const seen: string[] = []
    const app = new Hono<{
      Variables: { identity: RecordIdentity; destinationSpaceId?: string }
    }>()
    registerRecordPortRoutes(
      app,
      { listPortCatalogue: listRecordPortCatalogue, writePort: async () => null },
      { scope: () => ({ ...tenant(), spaceId: pagingSpaceId }), noSpace: () => new Response() },
    )
    let cursor: string | null = null
    let pages = 0
    for (;;) {
      const response = await app.request(
        `/v1/port-catalogue/port_skip?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
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

  test('pages nullable port timestamps as ISO values accepted by the client schema', async () => {
    const doctrineId = newRecordId(),
      baselineId = newRecordId(),
      refId = newRecordId(),
      sourceId = newRecordId(),
      at = '2026-10-19T12:34:56.789Z'
    const sql = new SQL(url!)
    try {
      await sql.begin(async (tx) => {
        await tx`INSERT INTO port_doctrine (id,space_id,number,title,body,created_at,retired_at,version,updated_at)
          VALUES (${doctrineId}::uuid,${pagingSpaceId}::uuid,1409,'Retired doctrine','Proof',${at}::timestamptz,${at}::timestamptz,2,${at}::timestamptz)`
        await tx`INSERT INTO port_baseline (id,space_id,pair_id,source_commit,scanned_at,version,updated_at)
          VALUES (${baselineId}::uuid,${pagingSpaceId}::uuid,${pagingPairId}::uuid,'deadbeef',${at}::timestamptz,1,${at}::timestamptz)`
        await tx`INSERT INTO port_ref (id,space_id,task_key,target_project_id,note,created_at,resolved_at,deleted_at,version,updated_at)
          VALUES (${refId}::uuid,${pagingSpaceId}::uuid,'DEV-1409',${pagingTargetProjectId}::uuid,'Proof',${at}::timestamptz,${at}::timestamptz,${at}::timestamptz,3,${at}::timestamptz)`
        await tx`INSERT INTO port_ref_source (id,space_id,ref_id,source_project_id,commits,paths,note,deleted_at,updated_at)
          VALUES (${sourceId}::uuid,${pagingSpaceId}::uuid,${refId}::uuid,${pagingSourceProjectId}::uuid,'deadbeef','orchestrator/','Proof',${at}::timestamptz,${at}::timestamptz)`
      })
    } finally {
      await sql.close()
    }

    const app = new Hono<{
      Variables: { identity: RecordIdentity; destinationSpaceId?: string }
    }>()
    registerRecordPortRoutes(
      app,
      {
        listPortCatalogue: listRecordPortCatalogue,
        writePort: async () => null,
      },
      {
        scope: () => ({ ...tenant(), spaceId: pagingSpaceId }),
        noSpace: () => new Response(),
      },
    )
    const expected = {
      port_doctrine: { retiredAt: at },
      port_baseline: { scannedAt: at },
      port_ref: { resolvedAt: at, deletedAt: at },
      port_ref_source: { deletedAt: at },
    } as const
    for (const table of Object.keys(expected) as (keyof typeof expected)[]) {
      const response = await app.request(`/v1/port-catalogue/${table}?limit=20`)
      const page = recordPortPageSchema(table as RecordPortTable).parse(await response.json())
      expect(page.items).toHaveLength(1)
      expect(page.items[0]).toMatchObject(expected[table])
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
