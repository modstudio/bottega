import { beforeEach, expect, test } from 'bun:test'
import { resetFixtureStore } from '../../test/run-fixtures.ts'
import { db, writeTransaction } from '../db.ts'
import { upsertGitTasks } from './git-task-cache.ts'

const task = { key: 'FIX-1', project: 'fixture', first: '2026-10-01', last: '2026-10-02' }
const queued = () => db().query<{ row_id: string }, []>(`SELECT row_id FROM hosted_outbox`).all()

beforeEach(resetFixtureStore)

test('git tasks queue on insert and a meaningful change but not on observation time alone', () => {
  writeTransaction((conn) => upsertGitTasks(conn, [task], '2026-10-11T12:00:00.000Z'))
  expect(queued()).toHaveLength(1)
  writeTransaction((conn) => conn.exec(`DELETE FROM hosted_outbox`))

  writeTransaction((conn) => upsertGitTasks(conn, [task], '2026-10-11T13:00:00.000Z'))
  expect(queued()).toHaveLength(0)

  writeTransaction((conn) =>
    upsertGitTasks(conn, [{ ...task, last: '2026-10-03' }], '2026-10-11T14:00:00.000Z'),
  )
  expect(queued()).toHaveLength(1)
})

test('the git task and its outbox pointer roll back together', () => {
  writeTransaction((conn) =>
    conn.exec(`CREATE TEMP TRIGGER refuse_git_outbox BEFORE INSERT ON hosted_outbox
      BEGIN SELECT RAISE(ABORT,'refuse git outbox'); END`),
  )
  expect(() =>
    writeTransaction((conn) => upsertGitTasks(conn, [task], '2026-10-11T12:00:00.000Z')),
  ).toThrow('refuse git outbox')
  expect(db().query(`SELECT 1 FROM task WHERE key=?`).get(task.key)).toBeNull()
})

test('git observations never queue tracker or local owned rows', () => {
  for (const [key, source] of [
    ['FIX-2', 'mcp'],
    ['FIX-3', 'local'],
  ] as const) {
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO task(record_id,key,project,title,status,body,source,first_seen,last_seen,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          `0199b002-0000-7000-8000-00000000000${source === 'mcp' ? '2' : '3'}`,
          key,
          'fixture',
          `Hosted ${source} title`,
          'active',
          `Hosted ${source} body`,
          source,
          '2026-10-01T00:00:00.000Z',
          '2026-10-02T00:00:00.000Z',
          '2026-09-30T00:00:00.000Z',
        ),
    )
  }

  writeTransaction((conn) =>
    upsertGitTasks(
      conn,
      [
        { ...task, key: 'FIX-2' },
        { ...task, key: 'FIX-3' },
      ],
      '2026-10-11T12:00:00.000Z',
    ),
  )

  expect(queued()).toHaveLength(0)
  expect(
    db()
      .query<{ source: string; last_seen: string; updated_at: string }, []>(
        `SELECT source,last_seen,updated_at FROM task WHERE key IN ('FIX-2','FIX-3') ORDER BY key`,
      )
      .all(),
  ).toEqual([
    {
      source: 'mcp',
      last_seen: '2026-10-11T12:00:00.000Z',
      updated_at: '2026-10-02',
    },
    {
      source: 'local',
      last_seen: '2026-10-11T12:00:00.000Z',
      updated_at: '2026-10-02',
    },
  ])
})
