import { beforeAll, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { confirmSoftDelete } from './hosted-tasks.ts'
import { createTask } from './task.ts'
import { taskApi } from './task-api.ts'
import { applyHostedTaskChanges } from './task-cache.ts'
import { closeThenPrune } from './task-close.ts'

beforeAll(resetFixtureStore)

describe('hosted-only task safety', () => {
  test('an unreachable hosted write refuses and leaves the cache unchanged', async () => {
    const before = db().query<{ count: number }, []>(`SELECT count(*) count FROM task`).get()!.count
    await expect(
      createTask(
        { project: 'workshop', title: 'Must not enter the cache' },
        {
          hosted: {
            baseUrl: 'https://hub.example.test',
            token: 'test',
            fetch: async () => {
              throw new Error('offline')
            },
          },
        },
      ),
    ).rejects.toThrow('HUB_HOSTED_URL')
    expect(db().query<{ count: number }, []>(`SELECT count(*) count FROM task`).get()!.count).toBe(
      before,
    )
  })

  test('close never prunes after a hosted close failure', async () => {
    let pruned = false
    await expect(
      closeThenPrune('DEV-1', false, {
        close: async () => {
          throw new Error('hosted close failed')
        },
        prune: async (project, key) => {
          pruned = true
          return {
            project,
            key,
            dryRun: false,
            deleted: [],
            kept: [],
            operator: [],
            wouldDelete: [],
            errors: [],
          }
        },
      }),
    ).rejects.toThrow('hosted close failed')
    expect(pruned).toBeFalse()
  })

  test('multi-row soft deletes require the exact confirmation count', () => {
    expect(() => confirmSoftDelete(2)).toThrow('confirmation count 2')
    expect(() => confirmSoftDelete(2, 1)).toThrow('confirmation count 2')
    expect(() => confirmSoftDelete(2, 2)).not.toThrow()
  })

  test('the task API refuses real dependencies under the test runner', async () => {
    await expect(
      taskApi(
        new Request('https://hub.example.test/v1/tasks', {
          headers: { authorization: 'Bearer test' },
        }),
        {
          recordApiUrl: 'https://record.example.test',
          recordDatabaseUrl: 'postgres://real',
        },
      ),
    ).rejects.toThrow('unless stubs are injected')
  })

  test('cache pull applies an update and a soft delete', () => {
    const at = '2026-09-17T12:00:00.000Z'
    writeTransaction((conn) => {
      conn
        .query(`INSERT INTO task(record_id,key,project,title,status,status_category,source,first_seen,last_seen)
        VALUES ('01990000-0000-7000-8000-000000000101','DEV-990','workshop','old','open','open','local',?,?)`)
        .run(at, at)
      conn
        .query(`INSERT INTO task_document(record_id,task_key,title,body,version,created_at,updated_at)
        VALUES ('01990000-0000-7000-8000-000000000102','DEV-990','old','body','v1',?,?)`)
        .run(at, at)
    })
    applyHostedTaskChanges({
      tasks: [
        {
          id: '01990000-0000-7000-8000-000000000101',
          key: 'DEV-990',
          project: 'workshop',
          project_name: 'workshop',
          title: 'new',
          status: 'active',
          status_category: 'active',
          parent_key: null,
          body: null,
          assignee: null,
          opened_at: at,
          closed_at: null,
          source: 'local',
          first_seen: at,
          last_seen: at,
          created_at: at,
          updated_at: '2026-09-17T12:01:00.000Z',
          deleted_at: null,
        },
      ],
      comments: [],
      statusEvents: [],
      documents: [
        {
          id: '01990000-0000-7000-8000-000000000102',
          legacy_local_id: null,
          task_key: 'DEV-990',
          project_name: 'workshop',
          role: null,
          title: 'old',
          body: 'body',
          version: 'v1',
          created_at: at,
          updated_at: '2026-09-17T12:01:00.000Z',
          deleted_at: '2026-09-17T12:01:00.000Z',
        },
      ],
      cursor: '2026-09-17T12:01:00.000Z',
    })
    expect(
      db().query<{ title: string }, []>(`SELECT title FROM task WHERE key='DEV-990'`).get()?.title,
    ).toBe('new')
    expect(
      db()
        .query<{ count: number }, []>(
          `SELECT count(*) count FROM task_document WHERE task_key='DEV-990'`,
        )
        .get()?.count,
    ).toBe(0)
  })
})
