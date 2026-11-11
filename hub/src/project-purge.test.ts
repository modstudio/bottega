import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from './migrations.ts'
import { purgeHubProject, uncoveredHubProjectTables } from './project-purge.ts'

const TARGET = '00000000-0000-7000-8000-000000000101'
const SIBLING = '00000000-0000-7000-8000-000000000102'

function migratedDatabase(): Database {
  const database = new Database(':memory:')
  applyMigrations(database, undefined, {
    machine_id: '00000000-0000-7000-8000-000000000001',
  })
  return database
}

test('the live hub schema has no uncovered project-bearing table', () => {
  const database = migratedDatabase()
  expect(uncoveredHubProjectTables(database)).toEqual([])
  database.close()
})

test('hub purge removes the target and its children while preserving a sibling', () => {
  const database = migratedDatabase()
  const insertTask = database.query(
    `INSERT INTO task(record_id,key,project,title,status,source,first_seen,last_seen,project_record_id)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  )
  insertTask.run('task-target', 'DEV-1', 'target', 'target', 'open', 'local', 'at', 'at', TARGET)
  insertTask.run(
    'task-sibling',
    'DEV-2',
    'sibling',
    'sibling',
    'open',
    'local',
    'at',
    'at',
    SIBLING,
  )
  insertTask.run(
    'task-target-name-only',
    'DEV-3',
    'target',
    'target name only',
    'open',
    'local',
    'at',
    'at',
    null,
  )
  insertTask.run(
    'task-sibling-name-only',
    'DEV-4',
    'sibling',
    'sibling name only',
    'open',
    'local',
    'at',
    'at',
    null,
  )
  database
    .query(
      `INSERT INTO task_comment(record_id,task_key,task_record_id,body,created_at)
       VALUES (?,?,?,?,?)`,
    )
    .run('comment-target', 'DEV-1', 'task-target', 'body', 'at')
  const insertNote = database.query(
    `INSERT INTO note(record_id,number,project,text,anchors,created_at,last_seen_at,project_record_id)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
  insertNote.run('note-target', 1, 'target', 'target', '[]', 'at', 'at', TARGET)
  insertNote.run('note-sibling', 2, 'sibling', 'sibling', '[]', 'at', 'at', SIBLING)
  database
    .query(
      `INSERT INTO note_acknowledgement(record_id,note_record_id,session_id,acknowledged_at,sightings)
       VALUES (?,?,?,?,?)`,
    )
    .run('ack-target', 'note-target', 'session', 'at', 1)
  database
    .query(
      `INSERT INTO hosted_outbox(id,table_name,row_id,operation,queued_at,routing_project_record_id)
       VALUES (?,?,?,?,?,?)`,
    )
    .run('outbox-target', 'hub_task', 'task-target', 'upsert', 'at', TARGET)
  const insertClaim = database.query(
    `INSERT INTO task_identity_claim(project,external_id,key,first_seen,last_seen,project_record_id)
     VALUES (?,?,?,?,?,?)`,
  )
  insertClaim.run('target', 'target-external', 'DEV-5', 'at', 'at', null)
  insertClaim.run('sibling', 'sibling-external', 'DEV-6', 'at', 'at', null)

  const report = purgeHubProject(database, TARGET, 'target')
  expect(Object.fromEntries(report.map(({ table, count }) => [table, count]))).toMatchObject({
    task_comment: 1,
    task: 2,
    note_acknowledgement: 1,
    note: 1,
    hosted_outbox: 1,
    task_identity_claim: 1,
  })
  expect(database.query('SELECT record_id FROM task ORDER BY record_id').all()).toEqual([
    { record_id: 'task-sibling' },
    { record_id: 'task-sibling-name-only' },
  ])
  expect(database.query("SELECT 1 FROM note WHERE record_id='note-target'").get()).toBeNull()
  expect(database.query("SELECT 1 FROM note WHERE record_id='note-sibling'").get()).not.toBeNull()
  expect(database.query('SELECT project FROM task_identity_claim ORDER BY project').all()).toEqual([
    { project: 'sibling' },
  ])
  database.close()
})
