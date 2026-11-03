import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { applyMigrations } from './migrations.ts'
import { taskFlowBackfillReports } from './task-flow-migration-preflight.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

let reports: string[] = []
let reportSpy: ReturnType<typeof spyOn> | null = null

beforeEach(() => {
  reports = []
  reportSpy = spyOn(console, 'error').mockImplementation((...values) => {
    reports.push(values.join(' '))
  })
})

afterEach(() => {
  reportSpy?.mockRestore()
  reportSpy = null
})

test('backfills the newest resolved stage and reports every cursor it leaves unmerged', () => {
  const d = migrationBoundaryTestDatabase('0198_task_flow')
  try {
    const projectId = newRecordId()
    d.query(
      `INSERT INTO project(record_id,name,path,canon,settings)
       VALUES (?,'fixture','/fixture',0,'{"trunk":"main"}')`,
    ).run(projectId)
    const workflowVersion = workflowVersionRecordId(d)
    const catalogueVersion = catalogueVersionRecordId(d)
    const insert = d.query(
      `INSERT INTO workflow_cursor
        (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,
         task_record_id,instance_id,session_id,workflow_version_record_id,
         catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,
         total_steps,created_at,updated_at,enforcement)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture',?,
               ?,'default',?,?, '',NULL,?,?,'{}','{}',0,'start','running','[]',
               NULL,1,'2026-11-01','2026-11-01','floors') RETURNING number,record_id`,
    )
    const add = (
      workflow: string,
      key: string,
      task: string | null,
      cursorProjectId: string | null = projectId,
    ) =>
      insert.get(
        newRecordId(),
        cursorProjectId,
        workflow,
        key,
        task,
        workflowVersion,
        catalogueVersion,
      ) as {
        number: number
        record_id: string
      }
    const older = add('plan-task', 'DEV-1', 'task-1')
    const newest = add('ship-task', 'DEV-1', 'task-1')
    const unresolved = add('ship-task', 'DEV-2', null)
    const taskless = add('ship-task', '', null)

    applyMigrations(d)

    expect(
      d.query('SELECT task_record_id,open_stage_cursor_record_id,state FROM task_flow').all(),
    ).toEqual([
      {
        task_record_id: 'task-1',
        open_stage_cursor_record_id: newest.record_id,
        state: 'open',
      },
    ])
    expect(
      d.query('SELECT number,task_flow_record_id FROM workflow_cursor ORDER BY number').all(),
    ).toEqual([
      { number: older.number, task_flow_record_id: null },
      { number: newest.number, task_flow_record_id: expect.any(String) },
      { number: unresolved.number, task_flow_record_id: null },
      { number: taskless.number, task_flow_record_id: null },
    ])
    const missing = add('ship-task', 'DEV-3', 'task-3')
    expect(taskFlowBackfillReports(d)).toEqual([
      `cursor ${older.number} not merged; cursor ${newest.number} is the task's stage`,
      `cursor ${unresolved.number} not merged; task key did not resolve`,
      `cursor ${missing.number} not merged; task flow was not created`,
    ])
  } finally {
    d.close()
  }
})

test('refuses a resolved stage whose project identity is null instead of silently skipping it', () => {
  const d = migrationBoundaryTestDatabase('0198_task_flow')
  try {
    const workflowVersion = workflowVersionRecordId(d)
    const catalogueVersion = catalogueVersionRecordId(d)
    d.query(
      `INSERT INTO workflow_cursor
        (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,
         task_record_id,instance_id,session_id,workflow_version_record_id,
         catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,
         total_steps,created_at,updated_at,enforcement)
       VALUES (?,1,'fixture',NULL,'ship-task','default','DEV-4','task-4','',NULL,?,?,'{}',
               '{}',0,'start','running','[]',NULL,1,'2026-11-01','2026-11-01','floors')`,
    ).run(newRecordId(), workflowVersion, catalogueVersion)

    expect(() => applyMigrations(d)).toThrow(
      'NOT NULL constraint failed: task_flow.project_record_id',
    )
  } finally {
    d.close()
  }
})

test('applying the task-flow migration reports a cursor the backfill leaves unmerged', () => {
  const d = migrationBoundaryTestDatabase('0198_task_flow')
  try {
    const projectId = newRecordId()
    d.query(
      `INSERT INTO project(record_id,name,path,canon,settings)
       VALUES (?,'fixture','/fixture',0,'{"trunk":"main"}')`,
    ).run(projectId)
    const workflowVersion = workflowVersionRecordId(d)
    const catalogueVersion = catalogueVersionRecordId(d)
    const insert = d.query<{ number: number }, string[]>(
      `INSERT INTO workflow_cursor
        (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,
         task_record_id,instance_id,session_id,workflow_version_record_id,
         catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,
         total_steps,created_at,updated_at,enforcement)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture',?,
               ?,'default','DEV-1','task-1','',NULL,?,?,'{}','{}',0,'start','running','[]',
               NULL,1,'2026-11-01','2026-11-01','floors') RETURNING number`,
    )
    const older = insert.get(
      newRecordId(),
      projectId,
      'plan-task',
      workflowVersion,
      catalogueVersion,
    )!
    const newest = insert.get(
      newRecordId(),
      projectId,
      'ship-task',
      workflowVersion,
      catalogueVersion,
    )!

    applyMigrations(d)

    expect(reports).toContain(
      `task flow migration: cursor ${older.number} not merged; cursor ${newest.number} is the task's stage`,
    )
  } finally {
    d.close()
  }
})
