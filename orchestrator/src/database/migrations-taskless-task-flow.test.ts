import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('task-flow migration permits taskless flows and keeps task identity unique when present', () => {
  const database = migrationBoundaryTestDatabase('0218_taskless_task_flow')
  const project = newRecordId()
  const existing = newRecordId()
  database
    .query(
      "INSERT INTO project(record_id,name,path,stack,settings) VALUES (?,'fixture','/fixture','bun','{}')",
    )
    .run(project)
  database
    .query(
      `INSERT INTO task_flow
       (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
        opening_machine_id,updated_machine_id,revision)
       VALUES (?,'task-existing',?,'open',NULL,'2026-11-12','2026-11-12',NULL,NULL,1)`,
    )
    .run(existing, project)

  applyMigrations(database)

  expect(
    database.query('SELECT task_record_id FROM task_flow WHERE record_id=?').get(existing),
  ).toEqual({ task_record_id: 'task-existing' })
  database
    .query(
      `INSERT INTO task_flow
       (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
        opening_machine_id,updated_machine_id,revision)
       VALUES (?,NULL,?,'open',NULL,'2026-11-12','2026-11-12',NULL,NULL,1)`,
    )
    .run(newRecordId(), project)
  database
    .query(
      `INSERT INTO task_flow
       (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
        opening_machine_id,updated_machine_id,revision)
       VALUES (?,NULL,?,'open',NULL,'2026-11-12','2026-11-12',NULL,NULL,1)`,
    )
    .run(newRecordId(), project)
  expect(() =>
    database
      .query(
        `INSERT INTO task_flow
         (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
          opening_machine_id,updated_machine_id,revision)
         VALUES (?,'task-existing',?,'open',NULL,'2026-11-12','2026-11-12',NULL,NULL,1)`,
      )
      .run(newRecordId(), project),
  ).toThrow()
})
