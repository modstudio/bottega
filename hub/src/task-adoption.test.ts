import { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { applyMigrations } from './migrations.ts'
import { persistTaskAdoptions, taskAdoptionCollisionCount } from './task-adoption.ts'

test('task adoption re-keys a local task and cascades to its children', () => {
  const conn = new Database(':memory:')
  conn.exec('PRAGMA foreign_keys = ON')
  applyMigrations(conn)
  conn.exec(`
    INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
    VALUES ('old-id','DEV-895','${PLATFORM_SLUG}','mcp','2026-09-24','2026-09-24');
    INSERT INTO task_comment(record_id,task_key,task_record_id,body,created_at)
    VALUES ('comment-id','DEV-895','old-id','child','2026-09-24');
  `)

  expect(
    persistTaskAdoptions(
      [{ table: 'task', project: PLATFORM_SLUG, key: 'DEV-895', id: 'hosted-id' }],
      conn,
    ),
  ).toBe(0)
  expect(conn.query<{ record_id: string }, []>(`SELECT record_id FROM task`).get()?.record_id).toBe(
    'hosted-id',
  )
  expect(
    conn.query<{ task_record_id: string }, []>(`SELECT task_record_id FROM task_comment`).get()
      ?.task_record_id,
  ).toBe('hosted-id')
  conn.close()
})

test('task adoption records and skips a local id collision', () => {
  const conn = new Database(':memory:')
  applyMigrations(conn)
  conn.exec(`
    INSERT INTO task(record_id,key,project,source,first_seen,last_seen) VALUES
      ('incoming-id','DEV-895','${PLATFORM_SLUG}','mcp','2026-09-24','2026-09-24'),
      ('hosted-id','OPS-21','stopal','mcp','2026-09-24','2026-09-24');
  `)
  const log = spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(
      persistTaskAdoptions(
        [{ table: 'task', project: PLATFORM_SLUG, key: 'DEV-895', id: 'hosted-id' }],
        conn,
      ),
    ).toBe(1)
    expect(taskAdoptionCollisionCount(conn)).toBe(1)
    expect(log).toHaveBeenCalledTimes(1)
  } finally {
    log.mockRestore()
    conn.close()
  }
})
