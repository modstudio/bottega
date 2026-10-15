import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { HUB_MIGRATION_BACKFILL_VALUES } from '../test/migration-values.ts'
import { upsertGitTasks } from './ingest/git-task-cache.ts'
import { applyMigrations } from './migrations.ts'
import { loadOutboxChange } from './outbox-row.ts'
import { backfillProjectRecordIds, projectRecordIdFor } from './project-record-id.ts'
import { refreshProjects } from './projects.ts'
import { HOSTED_TASK_TABLE } from './push-contract.ts'

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

test('a hub row written after the register has record_id carries project_record_id', () => {
  refreshProjects()
  const conn = new Database(':memory:')
  conn.exec('PRAGMA foreign_keys = ON')
  applyMigrations(conn, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  upsertGitTasks(
    conn,
    [
      {
        key: 'LOC-9',
        project: 'workshop',
        first: '2026-10-15T00:00:00.000Z',
        last: '2026-10-15T00:00:00.000Z',
      },
    ],
    '2026-10-15T00:00:00.000Z',
  )
  expect(
    conn
      .query<{ project_record_id: string | null }, []>(
        `SELECT project_record_id FROM task WHERE key='LOC-9'`,
      )
      .get()?.project_record_id,
  ).toBe('01990000-0000-7000-8000-000000000075')
})

test('the outbox payload carries projectId beside project_name', () => {
  const conn = new Database(':memory:')
  conn.exec('PRAGMA foreign_keys = ON')
  applyMigrations(conn, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  conn
    .query(
      `INSERT INTO task(record_id,key,project,project_record_id,source,first_seen,last_seen)
       VALUES ('cccccccc-cccc-4ccc-8ccc-ccccccccccc1','DEV-3','workshop',?,'git','2026-10-15T00:00:00.000Z','2026-10-15T00:00:00.000Z')`,
    )
    .run(MATCH)
  const loaded = loadOutboxChange(conn, {
    table_name: HOSTED_TASK_TABLE,
    row_id: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
    operation: 'upsert',
  })
  expect(loaded?.change).toMatchObject({
    table: HOSTED_TASK_TABLE,
    op: 'upsert',
    row: { project_name: 'workshop', projectId: MATCH },
  })
})

test('collect backfill fills a matching name and leaves an unmatched name null', () => {
  const conn = new Database(':memory:')
  conn.exec('PRAGMA foreign_keys = ON')
  applyMigrations(conn, undefined, HUB_MIGRATION_BACKFILL_VALUES)
  conn
    .query(`INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','DEV-1','workshop','git','t','t')`)
    .run()
  conn
    .query(`INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
    VALUES ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2','DEV-2','unknown','git','t','t')`)
    .run()
  conn
    .query(`INSERT INTO note(record_id,number,project,text,anchors,created_at,last_seen_at)
    VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',1,'workshop','text','[]','t','t')`)
    .run()
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
      .query<{ project: string; project_record_id: string | null }, []>(
        `SELECT project, project_record_id FROM note WHERE record_id='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'`,
      )
      .get(),
  ).toEqual({ project: 'workshop', project_record_id: MATCH })
})
