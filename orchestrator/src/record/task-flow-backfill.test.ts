import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { database } from '../workflow/workflow-cursor-test.fixture.ts'
import { taskFlowReadStore } from '../workflow/task-flow-store.ts'
import { abandonWorkflowCursor } from '../workflow/workflow-cursor-mutation.ts'
import type { SelectableCursorRow } from '../workflow/workflow-cursor-selection.ts'
import { insertOutboxRow } from './outbox-enqueue.ts'
import {
  backfillTaskFlowRecords,
  inspectTaskFlowBackfill,
  legacyTasklessFlowRecordId,
} from './task-flow-backfill.ts'

test('task-flow backfill asks the record, enqueues absent rows in parent order, and skips pending rows', async () => {
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
  const hostedTasklessStage = newRecordId()
  const doneTasklessStage = newRecordId()
  const abandonedTasklessStage = newRecordId()
  const unresolvedProject = newRecordId()
  const unresolvedFlow = newRecordId()
  d.query(
    `INSERT INTO project (record_id,name,path,stack,settings)
     VALUES (?,'unresolved','/unresolved','bun','{"trunk":"main"}')`,
  ).run(unresolvedProject)
  d.query(
    `INSERT INTO task_flow
     (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
      opening_machine_id,updated_machine_id,revision) VALUES (?,? ,?,'open',NULL,'2026-11-12','2026-11-12',?,?,1)`,
  ).run(unresolvedFlow, 'task-unresolved', unresolvedProject, machine, machine)
  d.query(
    `INSERT INTO task_flow
     (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,created_at,updated_at,
      opening_machine_id,updated_machine_id,revision) VALUES (?,?,?,'open',NULL,'2026-11-12','2026-11-12',?,?,1)`,
  ).run(flow, 'task-DEV-2234', project, machine, machine)
  const insertStage = (
    recordId: string,
    number: number,
    flowId: string | null,
    state = 'running',
  ) =>
    d
      .query(
        `INSERT INTO workflow_cursor
       (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,task_record_id,
        task_flow_record_id,instance_id,session_id,workflow_version_record_id,catalogue_version_record_id,
        args,autonomy,ordinal,step_slug,state,closed,question,total_steps,created_at,updated_at,enforcement,
        opened_machine_id,taken_over_from_machine_id,last_advanced_machine_id,revision)
       VALUES (?,?,'fixture',?,'flow','default','DEV-2234',?,?,?,'session',?,?,'{}','{}',0,'build',
        ?,'[]','why?',2,'2026-11-12','2026-11-12','floors',?,NULL,?,1)`,
      )
      .run(
        recordId,
        number,
        project,
        flowId ? 'task-DEV-2234' : null,
        flowId,
        flowId ? '' : `taskless-${number}`,
        workflowVersion,
        catalogueVersion,
        state,
        machine,
        machine,
      )
  insertStage(linkedStage, 1, flow)
  insertStage(tasklessStage, 2, null)
  insertStage(hostedTasklessStage, 3, null)
  insertStage(doneTasklessStage, 4, null, 'done')
  insertStage(abandonedTasklessStage, 5, null, 'abandoned')
  insertOutboxRow(d, {
    recordId: newRecordId(),
    kind: 'task_flow',
    rowId: flow,
    payload: '{}',
    createdAt: '2026-11-12',
  })
  const calls: Array<{ flowIds: string[]; stageIds: string[]; destinationSpaceId?: string }> = []
  const access = {
    memberships: [{ spaceId: 'space-id', slug: 'fixture-space', permission: 'write' }],
    personalSpaceId: null,
    client: {
      readTaskFlowPresence: async (
        input: { flowIds: string[]; stageIds: string[] },
        destination: { destinationSpaceId?: string },
      ) => {
        calls.push({ ...input, destinationSpaceId: destination.destinationSpaceId })
        return {
          flowIds: [],
          stageIds: input.stageIds.filter((id) => id === linkedStage || id === hostedTasklessStage),
        }
      },
    },
  }

  const held = [
    {
      project: 'unresolved',
      rows: 1,
      reason: expect.stringContaining('record space'),
    },
  ]
  expect(await inspectTaskFlowBackfill(d, access)).toEqual({ flows: 1, stages: 3, held })
  expect(await backfillTaskFlowRecords(d, access)).toEqual({
    enqueuedFlows: 3,
    enqueuedStages: 3,
    held,
  })
  expect(await backfillTaskFlowRecords(d, access)).toEqual({
    enqueuedFlows: 0,
    enqueuedStages: 0,
    held,
  })
  expect(calls[0]).toMatchObject({
    flowIds: [flow],
    stageIds: [
      linkedStage,
      tasklessStage,
      hostedTasklessStage,
      doneTasklessStage,
      abandonedTasklessStage,
    ].sort(),
    destinationSpaceId: 'space-id',
  })

  const rows = d
    .query<{ kind: string; row_id: string; payload: string }, []>(
      "SELECT kind,row_id,payload FROM outbox WHERE payload<>'{}' ORDER BY id",
    )
    .all()
  const syntheticFlow = legacyTasklessFlowRecordId(tasklessStage)
  expect(rows.some((row) => row.row_id === legacyTasklessFlowRecordId(hostedTasklessStage))).toBe(
    false,
  )
  const syntheticDoneFlow = legacyTasklessFlowRecordId(doneTasklessStage)
  const syntheticAbandonedFlow = legacyTasklessFlowRecordId(abandonedTasklessStage)
  expect(rows.filter((row) => row.kind === 'task_flow').map((row) => row.row_id).sort()).toEqual(
    [syntheticFlow, syntheticDoneFlow, syntheticAbandonedFlow].sort(),
  )
  expect(rows.findLastIndex((row) => row.kind === 'task_flow')).toBeLessThan(
    rows.findIndex((row) => row.kind === 'task_flow_stage'),
  )
  expect(JSON.parse(rows.find((row) => row.row_id === syntheticFlow)!.payload)).toMatchObject({
    id: syntheticFlow,
    taskId: null,
    openStageRecordId: tasklessStage,
  })
  expect(JSON.parse(rows.find((row) => row.row_id === syntheticDoneFlow)!.payload)).toMatchObject({
    state: 'done',
    openStageRecordId: null,
  })
  expect(
    JSON.parse(rows.find((row) => row.row_id === syntheticAbandonedFlow)!.payload),
  ).toMatchObject({ state: 'dropped', openStageRecordId: null })
  expect(JSON.parse(rows.find((row) => row.row_id === tasklessStage)!.payload)).toMatchObject({
    flowRecordId: syntheticFlow,
    workflowKey: 'DEV-2234',
    instanceId: 'taskless-2',
    sessionId: 'session',
    question: 'why?',
    autonomy: '{}',
    enforcement: 'floors',
  })
  expect(
    d
      .query('SELECT task_flow_record_id FROM workflow_cursor WHERE record_id=?')
      .get(tasklessStage),
  ).toEqual({ task_flow_record_id: syntheticFlow })
  expect(
    d
      .query('SELECT task_record_id,state,open_stage_cursor_record_id FROM task_flow WHERE record_id=?')
      .get(syntheticFlow),
  ).toEqual({ task_record_id: null, state: 'open', open_stage_cursor_record_id: tasklessStage })

  const row = (await taskFlowReadStore(d).stageByRecordId(tasklessStage)) as SelectableCursorRow
  await abandonWorkflowCursor(
    row,
    'legacy stage closed',
    {
      session: 'session',
    },
    d,
  )
  expect(
    d
      .query('SELECT open_stage_cursor_record_id,revision FROM task_flow WHERE record_id=?')
      .get(syntheticFlow),
  ).toEqual({ open_stage_cursor_record_id: null, revision: 2 })
  expect(d.query('SELECT state,revision FROM workflow_cursor WHERE record_id=?').get(tasklessStage)).toEqual(
    { state: 'abandoned', revision: 2 },
  )
})
