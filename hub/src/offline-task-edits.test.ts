import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { queueHostedChange } from './outbox.ts'
import { closeTask, commentTask, createTask, setTask } from './task.ts'
import { applyHostedTaskRows } from './task-cache.ts'
import { createTaskDocument, deleteTaskDocument, updateTaskDocument } from './task-document.ts'

const unreachable = {
  baseUrl: 'https://unreachable.example.test',
  token: 'test',
  fetch: async () => {
    throw new Error('hosted hub unavailable')
  },
}

function seedTask(key = 'GAM-70') {
  const id = Bun.randomUUIDv7()
  const at = '2026-10-11T12:00:00.000Z'
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO task
        (record_id,key,project,title,status,status_category,source,first_seen,last_seen,updated_at)
        VALUES (?,?,'gamma','Before','open','open','local',?,?,?)`,
      )
      .run(id, key, at, at, at),
  )
  return id
}

function clearOutbox() {
  writeTransaction((conn) => conn.query(`DELETE FROM hosted_outbox`).run())
}

beforeEach(resetFixtureStore)

test('field queues union, while a whole-row queue dominates either order and delete clears fields', () => {
  const id = seedTask()
  writeTransaction((conn) => {
    queueHostedChange(conn, 'hub_task', id, 'upsert', '2026-10-11T12:01:00.000Z', ['title'])
    queueHostedChange(conn, 'hub_task', id, 'upsert', '2026-10-11T12:02:00.000Z', ['status'])
  })
  expect(
    JSON.parse(
      db().query<{ fields: string }, []>(`SELECT fields FROM hosted_outbox`).get()!.fields,
    ).sort(),
  ).toEqual(['status', 'title'])

  writeTransaction((conn) => queueHostedChange(conn, 'hub_task', id, 'upsert'))
  expect(
    db().query<{ fields: string | null }, []>(`SELECT fields FROM hosted_outbox`).get()!.fields,
  ).toBeNull()
  writeTransaction((conn) => queueHostedChange(conn, 'hub_task', id, 'upsert', undefined, ['body']))
  expect(
    db().query<{ fields: string | null }, []>(`SELECT fields FROM hosted_outbox`).get()!.fields,
  ).toBeNull()
  writeTransaction((conn) => queueHostedChange(conn, 'hub_task', id, 'delete'))
  expect(
    db().query<{ fields: string | null }, []>(`SELECT fields FROM hosted_outbox`).get()!.fields,
  ).toBeNull()
})

test('all existing-row task edits succeed offline and queue exactly their changed rows', async () => {
  const id = seedTask()
  await setTask('GAM-70', { recordId: id }, { title: 'Offline title' }, { hosted: unreachable })
  expect(db().query(`SELECT title FROM task WHERE record_id=?`).get(id)).toEqual({
    title: 'Offline title',
  })
  expect(db().query(`SELECT table_name,fields FROM hosted_outbox`).all()).toEqual([
    { table_name: 'hub_task', fields: '["title"]' },
  ])

  clearOutbox()
  await commentTask('GAM-70', { recordId: id }, 'offline comment', { hosted: unreachable })
  expect(db().query(`SELECT body FROM task_comment`).get()).toEqual({ body: 'offline comment' })
  expect(db().query(`SELECT table_name FROM hosted_outbox`).all()).toEqual([
    { table_name: 'hub_task_comment' },
  ])

  clearOutbox()
  await closeTask(
    'GAM-70',
    { recordId: id },
    {
      hosted: unreachable,
      classify: async () => ({
        project: 'gamma',
        key: 'GAM-70',
        dryRun: true,
        deleted: [],
        kept: [],
        operator: [],
        wouldDelete: [],
        errors: [],
      }),
    },
  )
  expect(db().query(`SELECT status_category FROM task WHERE record_id=?`).get(id)).toEqual({
    status_category: 'done',
  })
  expect(
    db()
      .query<{ table_name: string }, []>(`SELECT table_name FROM hosted_outbox ORDER BY table_name`)
      .all(),
  ).toEqual([{ table_name: 'hub_task' }, { table_name: 'hub_task_status_event' }])
})

test('document edits and deletion succeed offline without resurrection state', async () => {
  const taskId = seedTask()
  const documentId = Bun.randomUUIDv7()
  const at = '2026-10-11T12:00:00.000Z'
  writeTransaction((conn) =>
    conn
      .query(`INSERT INTO task_document
      (record_id,task_key,task_record_id,number,title,body,version,created_at,updated_at)
      VALUES (?,'GAM-70',?,1,'Before','body','v1',?,?)`)
      .run(documentId, taskId, at, at),
  )
  await updateTaskDocument(documentId, { title: 'After' }, { hosted: unreachable })
  expect(db().query(`SELECT title FROM task_document WHERE record_id=?`).get(documentId)).toEqual({
    title: 'After',
  })
  expect(db().query(`SELECT operation,fields FROM hosted_outbox`).get()).toEqual({
    operation: 'upsert',
    fields: '["title"]',
  })

  await deleteTaskDocument(documentId, { hosted: unreachable })
  expect(db().query(`SELECT 1 FROM task_document WHERE record_id=?`).get(documentId)).toBeNull()
  expect(db().query(`SELECT operation,fields FROM hosted_outbox`).get()).toEqual({
    operation: 'delete',
    fields: null,
  })
})

test('creation still requires hosting and local-authoritative edits queue nothing', async () => {
  await expect(
    createTask({ project: 'gamma', title: 'Cannot create offline' }, { hosted: unreachable }),
  ).rejects.toThrow('hosted hub unavailable')
  const id = seedTask('BET-70')
  writeTransaction((conn) => conn.query(`UPDATE task SET project='beta' WHERE record_id=?`).run(id))
  expect(db().query(`SELECT table_name,row_id FROM hosted_outbox`).all()).toHaveLength(0)
  await setTask('BET-70', { recordId: id }, { title: 'Local only' }, { hosted: { baseUrl: '' } })
  expect(db().query(`SELECT 1 FROM hosted_outbox`).all()).toHaveLength(0)

  await expect(
    createTaskDocument(
      { task: 'GAM-70', title: 'Cannot create offline' },
      { recordId: seedTask('GAM-71') },
      { hosted: unreachable },
    ),
  ).rejects.toThrow('hosted hub unavailable')
})

test('pull preserves pending task fields and never resurrects a pending document delete', async () => {
  const id = seedTask()
  await setTask('GAM-70', { recordId: id }, { title: 'Pending title' }, { hosted: unreachable })
  const documentId = Bun.randomUUIDv7()
  const at = '2026-10-11T12:00:00.000Z'
  writeTransaction((conn) =>
    conn
      .query(`INSERT INTO task_document
      (record_id,task_key,task_record_id,number,title,body,version,created_at,updated_at)
      VALUES (?,'GAM-70',?,1,'Pending delete','body','v1',?,?)`)
      .run(documentId, id, at, at),
  )
  await deleteTaskDocument(documentId, { hosted: unreachable })

  writeTransaction((conn) =>
    applyHostedTaskRows(conn, {
      cursor: '2',
      tasks: [
        {
          id,
          key: 'GAM-70',
          project: 'gamma',
          project_name: 'gamma',
          title: 'Hosted title',
          status: 'review',
          status_category: 'review',
          parent_key: null,
          parent_id: null,
          body: null,
          assignee: null,
          opened_at: at,
          closed_at: null,
          source: 'local',
          first_seen: at,
          last_seen: '2026-10-11T13:00:00.000Z',
          created_at: at,
          updated_at: '2026-10-11T13:00:00.000Z',
          deleted_at: null,
          next_document_number: 2,
        },
      ],
      comments: [],
      documents: [
        {
          id: documentId,
          task_key: 'GAM-70',
          task_id: id,
          project_name: 'gamma',
          number: 1,
          role: null,
          title: 'Hosted document',
          body: 'hosted',
          version: 'hosted-v1',
          created_at: at,
          updated_at: '2026-10-11T13:00:00.000Z',
          deleted_at: null,
        },
      ],
      statusEvents: [],
    }),
  )
  expect(db().query(`SELECT title,status FROM task WHERE record_id=?`).get(id)).toEqual({
    title: 'Pending title',
    status: 'review',
  })
  expect(db().query(`SELECT 1 FROM task_document WHERE record_id=?`).get(documentId)).toBeNull()
})
