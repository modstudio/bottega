import { afterAll, expect, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { bindTenant } from '../../../shared/record/tenant.ts'
import { createHostedRecordFixture, pgliteSql } from '../../test/hosted-record-fixture.ts'
import { resetFixtureStore } from '../../test/run-fixtures.ts'

const taskKey = 'ALP-991'

const { db, writeTransaction } = await import('../db.ts')
const { applyHostedPushChangesInTransaction } = await import('../hosted-push-changes.ts')
const { loadOutboxChange } = await import('../outbox-row.ts')
const { parseHostedPushItem } = await import('../push-contract.ts')
const { ingestTrackers } = await import('./trackers.ts')

test('tracker backfill never queues or overwrites a local row with a missing update time', async () => {
  const originalFetch = globalThis.fetch
  const originalUrl = process.env.FIXTURE_NO_CREDENTIALS_MCP_URL
  const originalToken = process.env.FIXTURE_NO_CREDENTIALS_MCP_TOKEN
  process.env.FIXTURE_NO_CREDENTIALS_MCP_URL = 'https://tracker.invalid/mcp'
  process.env.FIXTURE_NO_CREDENTIALS_MCP_TOKEN = 'fixture'
  globalThis.fetch = (async (_input, init) => {
    if (init?.method === 'DELETE') return new Response(null)
    const message = JSON.parse(String(init?.body)) as {
      id?: number
      method: string
      params?: { arguments?: Record<string, unknown> }
    }
    if (message.method === 'server/discover') return new Response('not found', { status: 404 })
    if (message.method === 'notifications/initialized') return new Response(null)
    const result =
      message.method === 'initialize'
        ? {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          }
        : {
            content: [
              {
                type: 'text',
                text: JSON.stringify(
                  'status' in (message.params?.arguments ?? {})
                    ? { tasks: [], last_page: 1 }
                    : {
                        tasks: [
                          {
                            id: 'tracker-alpha-991',
                            short_id: taskKey,
                            summary: 'Stale local title',
                            status: 'completed',
                            status_category: 'done',
                          },
                        ],
                      },
                ),
              },
            ],
          }
    return Response.json({ jsonrpc: '2.0', id: message.id, result })
  }) as typeof fetch
  resetFixtureStore()
  const userId = '01990000-0000-7000-8000-000000001290'
  const spaceId = '01990000-0000-7000-8000-000000001291'
  const taskId = '01990000-0000-7000-8000-000000001292'
  const projectId = '01990000-0000-7000-8000-000000001101'
  const database = await createHostedRecordFixture({ spaceId, userId })
  try {
    await database.exec(`RESET ROLE;
      INSERT INTO project(id,space_id,name,created_at) VALUES ('${projectId}','${spaceId}','alpha',now());
      SET ROLE record_actor;`)
    await database.transaction(async (transaction) => {
      const sql = pgliteSql(transaction as unknown as PGlite)
      sql.unsafe = (async (statement: string) =>
        (await transaction.query(statement)).rows) as SQL['unsafe']
      await bindTenant(sql, { userId, spaceId })
      return applyHostedPushChangesInTransaction(sql, { userId, spaceId }, [
        {
          table: 'hub_task',
          id: taskId,
          op: 'upsert',
          row: {
            id: taskId,
            key: taskKey,
            project: 'alpha',
            project_name: 'alpha',
            projectId,
            title: 'Newer hosted title',
            status: 'review',
            status_category: 'review',
            parent_key: null,
            body: 'Newer hosted body',
            assignee: null,
            opened_at: '2026-10-01T00:00:00.000Z',
            closed_at: null,
            source: 'local',
            first_seen: '2026-10-01T00:00:00.000Z',
            last_seen: '2026-10-10T00:00:00.000Z',
            created_at: '2026-10-01T00:00:00.000Z',
            updated_at: '2026-10-10T00:00:00.000Z',
            deleted_at: null,
            next_document_number: 1,
          },
        },
      ])
    })

    writeTransaction((conn) => {
      conn
        .query(
          `INSERT INTO task
           (record_id,key,project,project_record_id,title,status,status_category,body,source,first_seen,last_seen,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`,
        )
        .run(
          taskId,
          taskKey,
          'alpha',
          projectId,
          'Stale local title',
          'open',
          'open',
          'Stale local body',
          'local',
          '2026-10-01T00:00:00.000Z',
          '2026-10-02T00:00:00.000Z',
        )
      conn
        .query(
          `INSERT INTO interval
           (record_id,task_key,project,project_record_id,source,start_at,end_at,ref)
           VALUES (?,?,?,?,'orch',?,?,?)`,
        )
        .run(
          '01990000-0000-7000-8000-000000001293',
          taskKey,
          'alpha',
          projectId,
          '2026-10-10T00:00:00.000Z',
          '2026-10-10T01:00:00.000Z',
          'run:991',
        )
    })

    await ingestTrackers()

    const pointers = db()
      .query<{ table_name: string; row_id: string; operation: 'upsert' | 'delete' }, []>(
        `SELECT table_name,row_id,operation FROM hosted_outbox
         WHERE table_name IN ('hub_task','hub_task_status_event')`,
      )
      .all()
    const changes = pointers.map((pointer) => {
      const loaded = loadOutboxChange(db(), pointer)
      if (!loaded) throw new Error('expected queued row to load')
      const parsed = parseHostedPushItem(loaded.change)
      if ('outcome' in parsed) throw new Error(parsed.outcome.reason)
      return parsed.input
    })
    if (changes.length) {
      await database.transaction(async (transaction) => {
        const sql = pgliteSql(transaction as unknown as PGlite)
        sql.unsafe = (async (statement: string) =>
          (await transaction.query(statement)).rows) as SQL['unsafe']
        await bindTenant(sql, { userId, spaceId, spaceIds: [spaceId] })
        return applyHostedPushChangesInTransaction(sql, { userId, spaceId }, changes)
      })
    }

    expect(changes).toHaveLength(0)
    expect(
      (await database.query(`SELECT title,status,body FROM hub_task WHERE id=$1`, [taskId])).rows,
    ).toEqual([
      {
        title: 'Newer hosted title',
        status: 'review',
        body: 'Newer hosted body',
      },
    ])
  } finally {
    await database.close()
    globalThis.fetch = originalFetch
    if (originalUrl === undefined) delete process.env.FIXTURE_NO_CREDENTIALS_MCP_URL
    else process.env.FIXTURE_NO_CREDENTIALS_MCP_URL = originalUrl
    if (originalToken === undefined) delete process.env.FIXTURE_NO_CREDENTIALS_MCP_TOKEN
    else process.env.FIXTURE_NO_CREDENTIALS_MCP_TOKEN = originalToken
  }
})

// restore the store this file bound or queued into, so the next file starts clean
afterAll(resetFixtureStore)
