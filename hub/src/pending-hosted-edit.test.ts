import { afterAll, beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { DELETED_ON_HOSTED_RECORD_REASON } from './hosted-delete.ts'
import { queueHostedChange } from './outbox.ts'
import { reconcilePulledRow } from './pending-hosted-edit.ts'

beforeEach(resetFixtureStore)
afterAll(resetFixtureStore)

function task(
  id: string,
  values: { key?: string; parent?: string; parentId?: string; status?: string } = {},
) {
  const at = '2026-10-11T12:00:00.000Z'
  writeTransaction((conn) =>
    conn
      .query(`INSERT INTO task
    (record_id,key,project,title,status,status_category,parent_key,parent_record_id,closed_at,source,first_seen,last_seen,updated_at)
    VALUES (?,?,'gamma','machine',?,?,?,? ,NULL,'local',?,?,?)`)
      .run(
        id,
        values.key ?? 'GAM-1',
        values.status ?? 'open',
        values.status ?? 'open',
        values.parent ?? null,
        values.parentId ?? null,
        at,
        at,
        at,
      ),
  )
}

test('a pulled delete quarantines a pending edit with its edited values before deleting', () => {
  const id = Bun.randomUUIDv7()
  task(id)
  writeTransaction((conn) => {
    queueHostedChange(conn, 'hub_task', id, 'upsert', '2026-10-11T12:01:00.000Z', ['title'])
    reconcilePulledRow(conn, {
      table: 'hub_task',
      id,
      operation: 'delete',
      current: () =>
        conn
          .query<Record<string, unknown>, [string]>(`SELECT * FROM task WHERE record_id=?`)
          .get(id) ?? null,
      apply: () => {},
      remove: () => conn.query(`DELETE FROM task WHERE record_id=?`).run(id),
      at: '2026-10-11T13:00:00.000Z',
    })
  })
  expect(db().query(`SELECT 1 FROM task WHERE record_id=?`).get(id)).toBeNull()
  expect(db().query(`SELECT quarantine_reason,kept_values FROM hosted_outbox`).get()).toEqual({
    quarantine_reason: DELETED_ON_HOSTED_RECORD_REASON,
    kept_values: JSON.stringify({ title: 'machine' }),
  })
})

test('pending parent and status edits protect their coupled machine columns', () => {
  const id = Bun.randomUUIDv7()
  const parentId = Bun.randomUUIDv7()
  const hostedParentId = Bun.randomUUIDv7()
  task(parentId, { key: 'GAM-A' })
  task(hostedParentId, { key: 'GAM-B' })
  task(id, { parent: 'GAM-A', parentId, status: 'done' })
  writeTransaction((conn) => {
    queueHostedChange(conn, 'hub_task', id, 'upsert', undefined, ['parent_key', 'status'])
    reconcilePulledRow(conn, {
      table: 'hub_task',
      id,
      operation: 'upsert',
      current: () =>
        conn
          .query<Record<string, unknown>, [string]>(`SELECT * FROM task WHERE record_id=?`)
          .get(id) ?? null,
      apply: () =>
        conn
          .query(
            `UPDATE task SET parent_key='GAM-B',parent_record_id=?,status='open',status_category='open',closed_at=NULL,last_seen='2026-10-11T14:00:00.000Z' WHERE record_id=?`,
          )
          .run(hostedParentId, id),
      remove: () => {},
    })
  })
  expect(
    db()
      .query(
        `SELECT parent_key,parent_record_id,status,status_category,last_seen FROM task WHERE record_id=?`,
      )
      .get(id),
  ).toEqual({
    parent_key: 'GAM-A',
    parent_record_id: parentId,
    status: 'done',
    status_category: 'done',
    last_seen: '2026-10-11T12:00:00.000Z',
  })
})

test('a pulled task delete keeps values from queued child edits before cascade', () => {
  const id = Bun.randomUUIDv7()
  const documentId = Bun.randomUUIDv7()
  task(id)
  writeTransaction((conn) => {
    conn
      .query(`INSERT INTO task_document
      (record_id,task_key,task_record_id,number,title,body,version,created_at,updated_at)
      VALUES (?,'GAM-1',?,1,'title','edited body','v1','2026-10-11T12:00:00.000Z','2026-10-11T12:00:00.000Z')`)
      .run(documentId, id)
    queueHostedChange(conn, 'hub_task_document', documentId, 'upsert', undefined, ['body'])
    reconcilePulledRow(conn, {
      table: 'hub_task',
      id,
      operation: 'delete',
      current: () =>
        conn
          .query<Record<string, unknown>, [string]>(`SELECT * FROM task WHERE record_id=?`)
          .get(id) ?? null,
      apply: () => {},
      remove: () => conn.query(`DELETE FROM task WHERE record_id=?`).run(id),
    })
  })
  expect(
    db().query(`SELECT kept_values FROM hosted_outbox WHERE row_id=?`).get(documentId),
  ).toEqual({ kept_values: JSON.stringify({ body: 'edited body' }) })
})
