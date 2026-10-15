import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { backfillProjectRecordIds, projectRecordIdFor } from './project-record-id.ts'

const MATCH = '01990000-0000-7000-8000-000000001214'
const register = [
  { name: 'workshop', record_id: MATCH },
  { name: 'ghost', record_id: null },
]

test('a register record_id is the stored project_record_id', () => {
  expect(projectRecordIdFor('workshop', register)).toBe(MATCH)
  expect(projectRecordIdFor('missing', register)).toBeNull()
  expect(projectRecordIdFor(null, register)).toBeNull()
})

test('collect backfill fills a matching name and leaves an unmatched name null', () => {
  const conn = new Database(':memory:')
  conn.exec('PRAGMA foreign_keys = ON')
  applyMigrations(conn)
  conn.query(`INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','DEV-1','workshop','git','t','t')`).run()
  conn.query(`INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','DEV-2','unknown','git','t','t')`).run()
  conn.query(`INSERT INTO note(record_id,number,project,text,anchors,created_at,last_seen_at)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',1,'workshop','text','[]','t','t')`).run()
  backfillProjectRecordIds(conn, register)
  expect(
    conn
      .query<{ project_record_id: string | null }, [string]>(
        'SELECT project_record_id FROM task WHERE key=?',
      )
      .get('DEV-1')?.project_record_id,
  ).toBe(MATCH)
  expect(
    conn
      .query<{ project_record_id: string | null }, [string]>(
        'SELECT project_record_id FROM task WHERE key=?',
      )
      .get('DEV-2')?.project_record_id,
  ).toBeNull()
  expect(
    conn
      .query<{ project_record_id: string | null }, []>(
        'SELECT project_record_id FROM note WHERE number=1',
      )
      .get()?.project_record_id,
  ).toBe(MATCH)
})
