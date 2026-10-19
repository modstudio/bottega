import { beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { Hono } from 'hono'
import { newRecordId } from '../../../shared/record/schema.ts'
import { migratePostgres } from '../postgres/postgres-migrate.ts'
import { registerRecordPortRoutes } from './record-api-port.ts'
import type { RecordIdentity } from './record-auth.ts'
import { listRecordPortCatalogue, writeRecordPort } from './record-port-catalogue.ts'

const url = process.env.ORCH_TEST_PORT_CATALOGUE_URL
const postgres = url ? describe : describe.skip
const spaceId = newRecordId()
const pagingSpaceId = newRecordId()
const userId = newRecordId()
const sourceProjectId = newRecordId()
const targetProjectId = newRecordId()
const pagingSourceProjectId = newRecordId()
const pagingTargetProjectId = newRecordId()
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
    const pairId = newRecordId()
    const ids = Array.from({ length: 5 }, () => newRecordId())
    const sql = new SQL(url!)
    try {
      await sql.begin(async (tx) => {
        await tx`INSERT INTO port_pair (id,space_id,source_project_id,target_project_id,created_at) VALUES (${pairId}::uuid,${pagingSpaceId}::uuid,${pagingSourceProjectId}::uuid,${pagingTargetProjectId}::uuid,now())`
        for (const [index, id] of ids.entries())
          await tx`INSERT INTO port_skip (id,space_id,pair_id,candidate,reason,skipped_at) VALUES (${id}::uuid,${pagingSpaceId}::uuid,${pairId}::uuid,${`candidate-${index}`},'paging proof',now())`
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
