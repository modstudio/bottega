import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { insertOutboxRow } from '../record/outbox-enqueue.ts'
import {
  backfillTaskFlowRecords,
  inspectTaskFlowBackfill,
  legacyTasklessFlowRecordId,
} from './task-flow-backfill.ts'
import { database } from './workflow-cursor-test.fixture.ts'

test('task-flow backfill enqueues flows before stages, mints taskless parents, and skips enqueued rows', () => {
  const d = database()
  const project = d
    .query<{ record_id: string }, []>("SELECT record_id FROM project WHERE name='fixture'")
    .get()!.record_id
  const workflowVersion = d
    .query<{ record_id: string }, []>('SELECT record_id FROM workflow_version LIMIT 1')
    .get()!.record_id
  const catalogueVersion = d
    .query<{ record_id: string }, []>('SELECT record_id FROM step_catalogue_version LIMIT 1')
    .get()!.record_id
  const machine = '01990000-0000-7000-8000-000000002234'
  const flow = newRecordId()
  const linkedStage = newRecordId()
  const tasklessStage = newRecordId()
  d.query(
    `INSERT INTO task_flow
     (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
      opening_machine_id,updated_machine_id,revision) VALUES (?,?,?,'open',NULL,'2026-11-12','2026-11-12',?,?,1)`,
  ).run(flow, 'task-DEV-2234', project, machine, machine)
  const insertStage = (recordId: string, number: number, flowId: string | null) =>
    d.query(
      `INSERT INTO workflow_cursor
       (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,task_record_id,
        task_flow_record_id,instance_id,session_id,workflow_version_record_id,catalogue_version_record_id,
        args,autonomy,ordinal,step_slug,state,closed,question,total_steps,created_at,updated_at,enforcement,
        opened_machine_id,taken_over_from_machine_id,last_advanced_machine_id,revision)
       VALUES (?,?,'fixture',?,'flow','default','DEV-2234',?,?,?,'session',?,?,'{}','{}',0,'build',
        'running','[]','why?',2,'2026-11-12','2026-11-12','floors',?,NULL,?,1)`,
    ).run(
      recordId,
      number,
      project,
      flowId ? 'task-DEV-2234' : null,
      flowId,
      flowId ? '' : 'taskless',
      workflowVersion,
      catalogueVersion,
      machine,
      machine,
    )
  insertStage(linkedStage, 1, flow)
  insertStage(tasklessStage, 2, null)
  insertOutboxRow(d, {
    recordId: newRecordId(),
    kind: 'task_flow_stage',
    rowId: linkedStage,
    payload: '{}',
    createdAt: '2026-11-12',
  })

  expect(inspectTaskFlowBackfill(d)).toEqual({ flows: 1, stages: 1 })
  expect(backfillTaskFlowRecords(d)).toEqual({ enqueuedFlows: 2, enqueuedStages: 1 })
  expect(backfillTaskFlowRecords(d)).toEqual({ enqueuedFlows: 0, enqueuedStages: 0 })
  expect(inspectTaskFlowBackfill(d)).toEqual({ flows: 0, stages: 0 })

  const rows = d
    .query<{ kind: string; row_id: string; payload: string }, []>(
      'SELECT kind,row_id,payload FROM outbox WHERE payload<>\'{}\' ORDER BY id',
    )
    .all()
  const syntheticFlow = legacyTasklessFlowRecordId(tasklessStage)
  expect(rows.map(({ kind, row_id }) => [kind, row_id])).toEqual([
    ['task_flow', flow],
    ['task_flow', syntheticFlow],
    ['task_flow_stage', tasklessStage],
  ])
  expect(JSON.parse(rows[1]!.payload)).toMatchObject({
    id: syntheticFlow,
    taskId: null,
    openStageRecordId: tasklessStage,
  })
  expect(JSON.parse(rows[2]!.payload)).toMatchObject({
    flowRecordId: syntheticFlow,
    workflowKey: 'DEV-2234',
    instanceId: 'taskless',
    sessionId: 'session',
    question: 'why?',
    autonomy: '{}',
    enforcement: 'floors',
  })
})
