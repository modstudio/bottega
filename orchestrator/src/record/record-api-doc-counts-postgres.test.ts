import { beforeAll, describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { Hono } from 'hono'
import { newRecordId } from '../../../shared/record/schema.ts'
import { migratePostgres } from '../postgres/postgres-migrate.ts'
import { registerRecordDocCountsRoute } from './record-api-doc-counts.ts'
import type { RecordIdentity } from './record-auth.ts'
import { countRecordCacheRows } from './record-cache-counts.ts'
import { countRecordDocs } from './record-docs.ts'

const url = process.env.BOTTEGA_TEST_DOC_COUNTS_URL
const postgres = url ? describe : describe.skip
const spaceId = newRecordId()
const userId = newRecordId()
const alphaId = newRecordId()
const betaId = newRecordId()
const tenant = () => ({ url: url!, spaceId, spaceIds: [spaceId], userId })

postgres('hosted document cache counts', () => {
  beforeAll(async () => {
    await migratePostgres(url)
    const sql = new SQL(url!)
    try {
      await sql`INSERT INTO space (id,name,slug,created_at) VALUES (${spaceId}::uuid,'Doc counts',${`doc-counts-${spaceId}`},now())`
      await sql`INSERT INTO project (id,space_id,name,created_at) VALUES
        (${alphaId}::uuid,${spaceId}::uuid,'alpha',now()),
        (${betaId}::uuid,${spaceId}::uuid,'beta',now())`
      await sql`INSERT INTO doc (id,space_id,scope,subject,slug,title,body,delivery,audiences,project_id,created_at,updated_at,deleted_at) VALUES
        (${newRecordId()}::uuid,${spaceId}::uuid,'project','alpha','alpha-live','Alpha','Body','demand',ARRAY['technical'],${alphaId}::uuid,now(),now(),NULL),
        (${newRecordId()}::uuid,${spaceId}::uuid,'project','beta','beta-live','Beta','Body','demand',ARRAY['technical'],${betaId}::uuid,now(),now(),NULL),
        (${newRecordId()}::uuid,${spaceId}::uuid,'global',NULL,'global-live','Global','Body','demand',ARRAY['technical'],NULL,now(),now(),NULL),
        (${newRecordId()}::uuid,${spaceId}::uuid,'project','alpha','alpha-deleted','Deleted','Body','demand',ARRAY['technical'],${alphaId}::uuid,now(),now(),now())`
      await sql`INSERT INTO subject (id,space_id,project_id,name,definition,position,retired_at,created_at,updated_at) VALUES
        (${newRecordId()}::uuid,${spaceId}::uuid,${alphaId}::uuid,'One','One subject',0,NULL,now(),now()),
        (${newRecordId()}::uuid,${spaceId}::uuid,${alphaId}::uuid,'Retired','Retired subject',1,now(),now(),now()),
        (${newRecordId()}::uuid,${spaceId}::uuid,${betaId}::uuid,'Two','Two subject',0,NULL,now(),now())`
    } finally {
      await sql.close()
    }
  })

  const app = () => {
    const server = new Hono<{
      Variables: { identity: RecordIdentity; destinationSpaceId?: string }
    }>()
    registerRecordDocCountsRoute(
      server,
      {
        countDocs: countRecordDocs,
        countScores: async () => ({ scores: 0, voids: 0 }),
        countCacheRows: countRecordCacheRows,
      },
      { scope: () => tenant(), noSpace: () => new Response() },
    )
    return server
  }

  test('returns exact live groups only when requested', async () => {
    const oldResponse = await app().request('/v1/docs/counts')
    expect(await oldResponse.json()).toEqual({ docs: 4, revisions: 0, scores: 0, voids: 0 })

    const groupedResponse = await app().request('/v1/docs/counts?by=scope')
    expect(await groupedResponse.json()).toEqual({
      docs: 4,
      revisions: 0,
      scores: 0,
      voids: 0,
      byScope: [
        { scope: 'global', project: null, docs: 1 },
        { scope: 'project', project: 'alpha', docs: 1 },
        { scope: 'project', project: 'beta', docs: 1 },
      ],
      subjectsByProject: [
        { project: 'alpha', subjects: 2 },
        { project: 'beta', subjects: 1 },
      ],
    })
  })
})
