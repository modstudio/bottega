import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { applyHostedTaskChanges } from './task-cache.ts'

const AT = '2026-10-08T12:00:00.000Z'
const TASK_A = '01990000-0000-7000-8000-000000000001'

beforeEach(resetFixtureStore)

function seedTask(recordId: string, key: string) {
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO task(record_id,key,project,title,source,first_seen,last_seen)
         VALUES (?,?,'workshop',?,'local',?,?)`,
      )
      .run(recordId, key, key, AT, AT),
  )
}

function changes(options: {
  ids: { comment: string; document: string; event: string }
  legacy: { comment: number; document: number; event: number }
  taskKey?: string
  deleted?: boolean
}) {
  const taskKey = options.taskKey ?? 'DEV-1'
  const deletedAt = options.deleted ? AT : null
  return {
    tasks: [],
    comments: [
      {
        id: options.ids.comment,
        legacy_local_id: options.legacy.comment,
        task_key: taskKey,
        project_name: 'workshop',
        body: 'hosted comment',
        created_at: AT,
        updated_at: AT,
        deleted_at: deletedAt,
      },
    ],
    documents: [
      {
        id: options.ids.document,
        legacy_local_id: options.legacy.document,
        task_key: taskKey,
        project_name: 'workshop',
        role: null,
        title: 'hosted document',
        body: 'hosted body',
        version: 'hosted-version',
        created_at: AT,
        updated_at: AT,
        deleted_at: deletedAt,
      },
    ],
    statusEvents: [
      {
        id: options.ids.event,
        legacy_local_id: options.legacy.event,
        task_key: taskKey,
        project_name: 'workshop',
        at: '2026-10-08T12:01:00.000Z',
        from_status: 'open',
        to_status: 'active',
        created_at: AT,
        updated_at: AT,
        deleted_at: deletedAt,
      },
    ],
    cursor: AT,
  }
}

test('matching record ids update and delete child rows', () => {
  seedTask(TASK_A, 'DEV-1')
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO task_comment(record_id,task_key,task_record_id,body,created_at)
         VALUES ('matched-comment','DEV-1',?,'local',?)`,
      )
      .run(TASK_A, AT)
    conn
      .query(
        `INSERT INTO task_document(id,record_id,task_key,task_record_id,title,body,version,created_at,updated_at)
         VALUES (402,'matched-document','DEV-1',?,'local','body','v1',?,?)`,
      )
      .run(TASK_A, AT, AT)
    conn
      .query(
        `INSERT INTO task_status_event(record_id,task_key,task_record_id,at,to_status)
         VALUES ('matched-event','DEV-1',?,?,'open')`,
      )
      .run(TASK_A, AT)
  })

  applyHostedTaskChanges(
    changes({
      ids: {
        comment: 'matched-comment',
        document: 'matched-document',
        event: 'matched-event',
      },
      legacy: { comment: 401, document: 402, event: 403 },
    }),
  )

  expect(
    db()
      .query<{ body: string }, []>(
        `SELECT body FROM task_comment WHERE record_id='matched-comment'`,
      )
      .get()?.body,
  ).toBe('hosted comment')
  expect(
    db().query<{ title: string }, []>(`SELECT title FROM task_document WHERE id=402`).get()?.title,
  ).toBe('hosted document')
  expect(
    db()
      .query<{ to_status: string }, []>(
        `SELECT to_status FROM task_status_event WHERE record_id='matched-event'`,
      )
      .get()?.to_status,
  ).toBe('active')
  expect(db().query(`SELECT * FROM task_comment`).all()).toHaveLength(1)
  expect(db().query(`SELECT * FROM task_status_event`).all()).toHaveLength(1)

  applyHostedTaskChanges(
    changes({
      ids: {
        comment: 'matched-comment',
        document: 'matched-document',
        event: 'matched-event',
      },
      legacy: { comment: 999, document: 999, event: 999 },
      deleted: true,
    }),
  )

  expect(db().query(`SELECT * FROM task_comment`).all()).toEqual([])
  expect(db().query(`SELECT * FROM task_document`).all()).toEqual([])
  expect(db().query(`SELECT * FROM task_status_event`).all()).toEqual([])
})
