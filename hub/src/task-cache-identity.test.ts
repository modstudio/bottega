import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { applyHostedTaskChanges } from './task-cache.ts'

const AT = '2026-10-08T12:00:00.000Z'
const TASK_A = '01990000-0000-7000-8000-000000000001'
const TASK_B = '01990000-0000-7000-8000-000000000002'

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

function recordIds(table: string) {
  return db()
    .query<{ record_id: string | null }, []>(`SELECT record_id FROM ${table} ORDER BY id`)
    .all()
    .map((row) => row.record_id)
}

test('same legacy ids from another space insert distinct child rows', () => {
  seedTask(TASK_A, 'DEV-1')
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO task_comment(id,record_id,task_key,task_record_id,body,created_at)
         VALUES (101,'space-a-comment','DEV-1',?,'original',?)`,
      )
      .run(TASK_A, AT)
    conn
      .query(
        `INSERT INTO task_document(id,record_id,task_key,task_record_id,title,body,version,created_at,updated_at)
         VALUES (102,'space-a-document','DEV-1',?,'original','body','v1',?,?)`,
      )
      .run(TASK_A, AT, AT)
    conn
      .query(
        `INSERT INTO task_status_event(id,record_id,task_key,task_record_id,at,from_status,to_status)
         VALUES (103,'space-a-event','DEV-1',?,?,'new','open')`,
      )
      .run(TASK_A, AT)
  })

  applyHostedTaskChanges(
    changes({
      ids: {
        comment: 'space-b-comment',
        document: 'space-b-document',
        event: 'space-b-event',
      },
      legacy: { comment: 101, document: 102, event: 103 },
    }),
  )

  expect(recordIds('task_comment')).toEqual(['space-a-comment', 'space-b-comment'])
  expect(recordIds('task_document')).toEqual(['space-a-document', 'space-b-document'])
  expect(recordIds('task_status_event')).toEqual(['space-a-event', 'space-b-event'])
})

test('tombstones with another row legacy id delete no child rows', () => {
  seedTask(TASK_A, 'DEV-1')
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO task_comment(id,record_id,task_key,task_record_id,body,created_at)
         VALUES (201,'kept-comment','DEV-1',?,'kept',?)`,
      )
      .run(TASK_A, AT)
    conn
      .query(
        `INSERT INTO task_document(id,record_id,task_key,task_record_id,title,body,version,created_at,updated_at)
         VALUES (202,'kept-document','DEV-1',?,'kept','body','v1',?,?)`,
      )
      .run(TASK_A, AT, AT)
    conn
      .query(
        `INSERT INTO task_status_event(id,record_id,task_key,task_record_id,at,to_status)
         VALUES (203,'kept-event','DEV-1',?,?,'open')`,
      )
      .run(TASK_A, AT)
  })

  applyHostedTaskChanges(
    changes({
      ids: { comment: 'other-comment', document: 'other-document', event: 'other-event' },
      legacy: { comment: 201, document: 202, event: 203 },
      deleted: true,
    }),
  )

  expect(recordIds('task_comment')).toEqual(['kept-comment'])
  expect(recordIds('task_document')).toEqual(['kept-document'])
  expect(recordIds('task_status_event')).toEqual(['kept-event'])
})

test('legacy ids adopt unhosted child rows belonging to the same task', () => {
  seedTask(TASK_A, 'DEV-1')
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO task_comment(id,task_key,task_record_id,body,created_at)
         VALUES (301,'DEV-1',?,'local',?)`,
      )
      .run(TASK_A, AT)
    conn
      .query(
        `INSERT INTO task_document(id,task_key,task_record_id,title,body,version,created_at,updated_at)
         VALUES (302,'DEV-1',?,'local','body','v1',?,?)`,
      )
      .run(TASK_A, AT, AT)
    conn
      .query(
        `INSERT INTO task_status_event(id,task_key,task_record_id,at,to_status)
         VALUES (303,'DEV-1',?,?,'open')`,
      )
      .run(TASK_A, AT)
  })

  applyHostedTaskChanges(
    changes({
      ids: { comment: 'adopt-comment', document: 'adopt-document', event: 'adopt-event' },
      legacy: { comment: 301, document: 302, event: 303 },
    }),
  )

  expect(recordIds('task_comment')).toEqual(['adopt-comment'])
  expect(recordIds('task_document')).toEqual(['adopt-document'])
  expect(recordIds('task_status_event')).toEqual(['adopt-event'])
})

test('legacy ids do not adopt unhosted child rows belonging to another task', () => {
  seedTask(TASK_A, 'DEV-1')
  seedTask(TASK_B, 'DEV-2')
  writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO task_comment(id,task_key,task_record_id,body,created_at)
         VALUES (401,'DEV-2',?,'local',?)`,
      )
      .run(TASK_B, AT)
    conn
      .query(
        `INSERT INTO task_document(id,task_key,task_record_id,title,body,version,created_at,updated_at)
         VALUES (402,'DEV-2',?,'local','body','v1',?,?)`,
      )
      .run(TASK_B, AT, AT)
    conn
      .query(
        `INSERT INTO task_status_event(id,task_key,task_record_id,at,to_status)
         VALUES (403,'DEV-2',?,?,'open')`,
      )
      .run(TASK_B, AT)
  })

  applyHostedTaskChanges(
    changes({
      ids: { comment: 'new-comment', document: 'new-document', event: 'new-event' },
      legacy: { comment: 401, document: 402, event: 403 },
    }),
  )

  expect(recordIds('task_comment')).toEqual([null, 'new-comment'])
  expect(recordIds('task_document')).toEqual([null, 'new-document'])
  expect(recordIds('task_status_event')).toEqual([null, 'new-event'])
})
