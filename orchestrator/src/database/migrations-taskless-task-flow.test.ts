import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

test('task-flow migration permits taskless flows and keeps task identity unique when present', () => {
  const database = migrationBoundaryTestDatabase('0218_taskless_task_flow')
  const project = newRecordId()
  const existing = newRecordId()
  const cursor = newRecordId()
  const workflow = newRecordId()
  const workflowVersion = newRecordId()
  const catalogue = newRecordId()
  const catalogueVersion = newRecordId()
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
  database
    .query("INSERT INTO workflow(record_id,slug,created_at) VALUES (?,'fixture','2026-11-12')")
    .run(workflow)
  database
    .query(
      `INSERT INTO workflow_version
       (record_id,workflow_record_id,n,status,definition,author,reason,created_at)
       VALUES (?,?,1,'production','{}','test','fixture','2026-11-12')`,
    )
    .run(workflowVersion, workflow)
  database
    .query("INSERT INTO step_catalogue(record_id,slug,created_at) VALUES (?,'shared','2026-11-12')")
    .run(catalogue)
  database
    .query(
      `INSERT INTO step_catalogue_version
       (record_id,catalogue_record_id,n,status,definition,author,reason,created_at)
       VALUES (?,?,1,'production','{}','test','fixture','2026-11-12')`,
    )
    .run(catalogueVersion, catalogue)
  database
    .query(
      `INSERT INTO workflow_cursor
       (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,instance_id,
        workflow_version_record_id,catalogue_version_record_id,args,total_steps,created_at,updated_at,
        task_flow_record_id)
       VALUES (?,1,'fixture',?,'fixture','default','DEV-2234','',?,?,'{}',1,'2026-11-12',
        '2026-11-12',?)`,
    )
    .run(cursor, project, workflowVersion, catalogueVersion, existing)

  applyMigrations(database)

  expect(
    database.query('SELECT task_record_id FROM task_flow WHERE record_id=?').get(existing),
  ).toEqual({ task_record_id: 'task-existing' })
  expect(
    database.query('SELECT task_flow_record_id FROM workflow_cursor WHERE record_id=?').get(cursor),
  ).toEqual({ task_flow_record_id: existing })
  expect(database.query('PRAGMA foreign_key_check').all()).toEqual([])
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
