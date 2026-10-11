import { expect, mock, test } from 'bun:test'
import type { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'bun'
import { bindTenant } from '../../shared/record/tenant.ts'
import { createHostedRecordFixture, pgliteSql } from '../test/hosted-record-fixture.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'

const taskKey = 'ALP-991'

mock.module('./mcp.ts', () => ({
  credentials: async () => ({ url: 'https://tracker.invalid/mcp', token: 'fixture' }),
  Mcp: class {
    async initialize() {}
    async close() {}
    async callTool(_name: string, args: Record<string, unknown>) {
      if ('status' in args) return { tasks: [], last_page: 1 }
      if (args.search === taskKey)
        return {
          tasks: [
            {
              id: 'tracker-alpha-991',
              short_id: taskKey,
              summary: 'Stale local title',
              status: 'completed',
              status_category: 'done',
            },
          ],
        }
      return { tasks: [] }
    }
  },
}))

const { db, writeTransaction } = await import('./db.ts')
const { applyHostedPushChangesInTransaction } = await import('./hosted-push-changes.ts')
const { mirrorHostedTaskBody } = await import('./hosted-tasks.ts')
const { ingestTrackers } = await import('./ingest/trackers.ts')
const { loadOutboxChange } = await import('./outbox-row.ts')
const { parseHostedPushItem } = await import('./push-contract.ts')

test('tracker backfill never queues or overwrites a local row with a missing update time', async () => {
  resetFixtureStore()
  const userId = '01990000-0000-7000-8000-000000001290'
  const spaceId = '01990000-0000-7000-8000-000000001291'
  const taskId = '01990000-0000-7000-8000-000000001292'
  const database = await createHostedRecordFixture({ spaceId, userId })
  try {
    await mirrorHostedTaskBody(
      pgliteSql(database),
      { userId, spaceId },
      {
        tasks: [
          {
            id: taskId,
            key: taskKey,
            project: 'alpha',
            project_name: 'alpha',
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
        ],
      },
      1,
    )

    writeTransaction((conn) => {
      conn
        .query(
          `INSERT INTO task
           (record_id,key,project,title,status,status_category,body,source,first_seen,last_seen,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,NULL)`,
        )
        .run(
          taskId,
          taskKey,
          'alpha',
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
           (record_id,task_key,project,source,start_at,end_at,ref)
           VALUES (?,?,?,'orch',?,?,?)`,
        )
        .run(
          '01990000-0000-7000-8000-000000001293',
          taskKey,
          'alpha',
          '2026-10-10T00:00:00.000Z',
          '2026-10-10T01:00:00.000Z',
          'run:991',
        )
    })

    await ingestTrackers()

    const pointers = db()
      .query<{ table_name: string; row_id: string; operation: 'upsert' | 'delete' }, []>(
        `SELECT table_name,row_id,operation FROM hosted_outbox`,
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
  }
})
