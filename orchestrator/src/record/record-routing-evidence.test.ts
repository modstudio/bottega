import { describe, expect, test } from 'bun:test'
import { SQL } from 'bun'
import { pageRecordItems, recordCursorAt, recordCursorOf } from './record-cursor.ts'
import { listRecordRoutingEvidence } from './record-routing-evidence.ts'

const actorUrl = process.env.BOTTEGA_RECORD_URL
const adminUrl = process.env.BOTTEGA_TEST_POSTGRES_URL
const realPostgres = actorUrl && adminUrl ? describe : describe.skip

const SPACE_ID = '01990000-0000-7000-8000-000000002013'
const USER_ID = '01990000-0000-7000-8000-000000002014'
const OUTSIDER_ID = '01990000-0000-7000-8000-000000002015'
const MEMBERSHIP_ID = '01990000-0000-7000-8000-000000002016'
const MACHINE_ID = '01990000-0000-7000-8000-000000002017'
const FIRST_RUN_ID = '01990000-0000-7000-8000-000000002018'
const SECOND_RUN_ID = '01990000-0000-7000-8000-000000002019'
const STAMP = '2026-11-01T16:00:00.000Z'

realPostgres('hosted routing evidence', () => {
  test('projects only readable evidence and pages an updated-at tie exactly once', async () => {
    const admin = new SQL(adminUrl!)
    try {
      await admin`INSERT INTO space (id,name,slug,created_at)
        VALUES (${SPACE_ID}::uuid,'Routing evidence proof','routing-evidence-proof',${STAMP}::timestamptz)`
      await admin`INSERT INTO "user" (id,email,name,created_at) VALUES
        (${USER_ID}::uuid,'routing-evidence@example.test','Routing Evidence',${STAMP}::timestamptz),
        (${OUTSIDER_ID}::uuid,'routing-outsider@example.test','Routing Outsider',${STAMP}::timestamptz)`
      await admin`INSERT INTO membership (id,space_id,user_id,role,permission,created_at)
        VALUES (${MEMBERSHIP_ID}::uuid,${SPACE_ID}::uuid,${USER_ID}::uuid,'member','write',${STAMP}::timestamptz)`
      await admin`INSERT INTO machine (id,user_id,name,registered_at,last_seen)
        VALUES (${MACHINE_ID}::uuid,${USER_ID}::uuid,'routing-proof',${STAMP}::timestamptz,${STAMP}::timestamptz)`

      const runIds = [
        FIRST_RUN_ID,
        SECOND_RUN_ID,
        '01990000-0000-7000-8000-000000002020',
        '01990000-0000-7000-8000-000000002021',
        '01990000-0000-7000-8000-000000002022',
        '01990000-0000-7000-8000-000000002023',
      ]
      for (const [index, id] of runIds.entries()) {
        const probe = index === 2
        const parent = index === 3 ? FIRST_RUN_ID : null
        const status = index === 4 ? 'running' : 'ok'
        const withheld = index === 5 ? ['agent'] : []
        await admin`INSERT INTO run (
          id,space_id,machine_id,started_by_user_id,started_at,agent,job,prompt_sha,prompt_bytes,
          prompt_head,probe,status,parent_run_id,turn,stack,model,executor,no_failover,
          automatic_failover,work_preserved,withheld_fields,created_at,updated_at
        ) VALUES (
          ${id}::uuid,${SPACE_ID}::uuid,${MACHINE_ID}::uuid,${USER_ID}::uuid,
          ${STAMP}::timestamptz,${`agent-${index}`},'implement','sha',123,'head',${probe},
          ${status},${parent}::uuid,1,'typescript','model-a',${index === 1 ? 'harness' : null},
          false,false,false,${JSON.stringify(withheld)}::jsonb,${STAMP}::timestamptz,${STAMP}::timestamptz
        )`
      }
      await admin`INSERT INTO run_score (
        run_id,space_id,delivery,quality,fidelity,scored_at,scored_by,withheld_fields,updated_at
      ) VALUES (
        ${FIRST_RUN_ID}::uuid,${SPACE_ID}::uuid,'full','right','faithful',${STAMP}::timestamptz,
        'architect','[]'::jsonb,${STAMP}::timestamptz
      )`
      await admin`INSERT INTO review_lens (
        id,space_id,review_id,run_id,machine_id,lens,agent,standards_read,files_covered,
        commands_run,could_not_verify,mcp_tools,docs_read,substitutes,created_at,updated_at
      ) VALUES (
        '01990000-0000-7000-8000-000000002024'::uuid,${SPACE_ID}::uuid,
        '01990000-0000-7000-8000-000000002025'::uuid,${FIRST_RUN_ID}::uuid,
        ${MACHINE_ID}::uuid,'fidelity','reviewer','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
        '[]'::jsonb,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,${STAMP}::timestamptz,${STAMP}::timestamptz
      )`

      const input = {
        url: actorUrl!,
        userId: USER_ID,
        spaceId: SPACE_ID,
        limit: 1,
        cursor: null,
      }
      const firstRows = await listRecordRoutingEvidence(input)
      const firstPage = pageRecordItems(firstRows, 1, recordCursorOf)
      expect(firstPage.items.map((row) => row.id)).toEqual([FIRST_RUN_ID])
      expect(firstPage.items[0]).toMatchObject({
        executor: 'external',
        delivery: 'full',
        quality: 'right',
        fidelity: 'faithful',
        lenses: ['fidelity'],
      })
      expect(Object.keys(firstPage.items[0]!)).toEqual([
        'id',
        'spaceId',
        'agent',
        'model',
        'job',
        'stack',
        'promptBytes',
        'status',
        'failureKind',
        'executor',
        'evidenceExcluded',
        'startedAt',
        'latencyMs',
        'vendorTokens',
        'modelCalls',
        'peakCallTokens',
        'delivery',
        'quality',
        'fidelity',
        'lenses',
      ])
      expect(firstPage.nextCursor).not.toBeNull()
      const secondRows = await listRecordRoutingEvidence({
        ...input,
        cursor: recordCursorOf(firstPage.items[0]!),
      })
      const secondPage = pageRecordItems(secondRows, 1, recordCursorOf)
      expect(secondPage.items.map((row) => row.id)).toEqual([SECOND_RUN_ID])
      expect(secondPage.items[0]).toMatchObject({ executor: 'harness', delivery: null, lenses: [] })
      expect(secondPage.nextCursor).toBeNull()
      expect(firstPage.items[0]![recordCursorAt]).toBe(secondPage.items[0]![recordCursorAt])

      expect(
        await listRecordRoutingEvidence({ ...input, userId: OUTSIDER_ID, limit: 100 }),
      ).toEqual([])
    } finally {
      await admin`DELETE FROM review_lens WHERE run_id IN (${FIRST_RUN_ID}::uuid,${SECOND_RUN_ID}::uuid)`
      await admin`DELETE FROM run_score WHERE space_id=${SPACE_ID}::uuid`
      await admin`DELETE FROM run WHERE space_id=${SPACE_ID}::uuid`
      await admin`DELETE FROM membership WHERE space_id=${SPACE_ID}::uuid`
      await admin`DELETE FROM machine_name_claim WHERE machine_id=${MACHINE_ID}::uuid`
      await admin`DELETE FROM machine WHERE id=${MACHINE_ID}::uuid`
      await admin`DELETE FROM "user" WHERE id IN (${USER_ID}::uuid,${OUTSIDER_ID}::uuid)`
      await admin`DELETE FROM space WHERE id=${SPACE_ID}::uuid`
      await admin.close()
    }
  })
})
