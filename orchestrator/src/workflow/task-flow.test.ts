import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { catalogueVersionRecordId, workflowVersionRecordId } from '../../test/fixtures/workflow.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { attachTaskFlowStage, closeTaskFlowStage, selectTaskFlowStage } from './task-flow.ts'
import { composeWorkflowWithCursor, nextWorkflowStep } from './workflow-cursor.ts'
import { vacateRetiredWorkflowKeySlot } from './workflow-cursor-adoption.ts'
import { selectWorkflowCursor } from './workflow-cursor-selection.ts'
import {
  abandonCursor,
  database as cursorDatabase,
  testPorts,
} from './workflow-cursor-test.fixture.ts'
import { promoteWorkflowLocal, setWorkflowLocal } from './workflows.ts'

function installTaskFlowLifecycleWorkflow(
  d: ReturnType<typeof cursorDatabase>,
  slug: string,
  steps: string[] = ['score'],
): void {
  const draft = setWorkflowLocal(
    slug,
    {
      title: `${slug} fixture`,
      description: 'Exercises task-flow lifecycle wiring.',
      arguments: [{ name: 'key', required: true, description: 'Task key.' }],
      modes: [{ slug: 'default', title: 'Default', default: true, steps }],
    },
    'task-flow lifecycle fixture',
    'test',
    d,
  )
  promoteWorkflowLocal(slug, draft.n, 'publish task-flow lifecycle fixture', 'test', d)
}

test('cursor commands attach, refuse overlap, finish, re-enter, and abandon task stages', () => {
  const d = cursorDatabase()
  const args = { key: 'DEV-FLOW' }
  const context = {
    session: 'task-flow-lifecycle',
    taskRecordId: 'task-DEV-FLOW',
    taskStatusCategory: 'active',
  }
  const plan = 'task-flow-plan'
  const ship = 'task-flow-ship'
  installTaskFlowLifecycleWorkflow(d, plan)
  installTaskFlowLifecycleWorkflow(d, ship)

  const opened = composeWorkflowWithCursor(plan, 'fixture', 'default', args, context, d, {}, {})
  const planCursor = opened.cursor!.id
  const pointers = (cursorNumber: number) =>
    d
      .query(
        `SELECT flow.open_stage_cursor_record_id openStage,cursor.record_id cursorId,
                cursor.task_flow_record_id cursorFlow,flow.record_id flowId
         FROM workflow_cursor cursor JOIN task_flow flow
           ON flow.task_record_id=cursor.task_record_id
         WHERE cursor.number=?`,
      )
      .get(cursorNumber) as {
      openStage: string | null
      cursorId: string
      cursorFlow: string | null
      flowId: string
    }
  const planPointers = pointers(planCursor)
  expect(planPointers).toMatchObject({
    openStage: planPointers.cursorId,
    cursorFlow: planPointers.flowId,
  })
  expect(() =>
    composeWorkflowWithCursor(ship, 'fixture', 'default', args, context, d, {}, {}),
  ).toThrow(`task DEV-FLOW already has open stage cursor ${planCursor} ${plan} default`)

  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(planCursor)
  nextWorkflowStep(plan, 'fixture', 'default', args, 'plan finished', context, d, {}, testPorts)
  expect(pointers(planCursor).openStage).toBeNull()

  const reentered = composeWorkflowWithCursor(ship, 'fixture', 'default', args, context, d, {}, {})
  const shipCursor = reentered.cursor!.id
  const shipPointers = pointers(shipCursor)
  expect(reentered.cursor?.opened).toBe(true)
  expect(shipPointers).toMatchObject({
    openStage: shipPointers.cursorId,
    cursorFlow: shipPointers.flowId,
  })

  abandonCursor(ship, 'fixture', 'default', args, 'stage no longer needed', context, d)
  expect(d.query('SELECT open_stage_cursor_record_id openStage FROM task_flow').get()).toEqual({
    openStage: null,
  })
})

test('keyed compose and advance enqueue both stage and flow while task-less compose enqueues neither', () => {
  const d = cursorDatabase()
  const workflow = 'task-flow-outbox'
  installTaskFlowLifecycleWorkflow(d, workflow, ['score', 'complete'])
  const args = { key: 'DEV-OUTBOX' }
  const context = {
    session: 'task-flow-outbox',
    taskRecordId: 'task-DEV-OUTBOX',
    taskStatusCategory: 'active',
  }

  const opened = composeWorkflowWithCursor(workflow, 'fixture', 'default', args, context, d, {}, {})
  const cursor = opened.cursor!.id
  expect(
    d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%' ORDER BY kind").all(),
  ).toEqual([{ kind: 'task_flow' }, { kind: 'task_flow_stage' }])

  d.query("DELETE FROM outbox WHERE kind LIKE 'task_flow%'").run()
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(cursor)
  nextWorkflowStep(workflow, 'fixture', 'default', args, 'advance', context, d, {}, testPorts)
  expect(
    d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%' ORDER BY kind").all(),
  ).toEqual([{ kind: 'task_flow' }, { kind: 'task_flow_stage' }])

  d.query("DELETE FROM outbox WHERE kind LIKE 'task_flow%'").run()
  const tasklessWorkflow = 'task-flow-taskless'
  installTaskFlowLifecycleWorkflow(d, tasklessWorkflow)
  composeWorkflowWithCursor(
    tasklessWorkflow,
    'fixture',
    'default',
    { key: 'DEV-TASKLESS' },
    { session: 'task-flow-taskless' },
    d,
    {},
    {},
  )
  expect(d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%'").all()).toEqual([])
})

function expectPendingFlowOutboxCleared(d: ReturnType<typeof cursorDatabase>): void {
  const rows = d
    .query<{ payload: string; revision: number }, []>(
      `SELECT outbox.payload,flow.revision FROM outbox
       JOIN task_flow flow ON flow.record_id=outbox.row_id
       WHERE outbox.kind='task_flow' AND outbox.synced_at IS NULL
         AND outbox.quarantined_at IS NULL AND outbox.retired_at IS NULL`,
    )
    .all()
  expect(rows).toHaveLength(1)
  expect(JSON.parse(rows[0]!.payload)).toMatchObject({
    openStageRecordId: null,
    revision: rows[0]!.revision,
  })
}

test('finishing a keyed stage enqueues the cleared task flow at its local revision', () => {
  const d = cursorDatabase()
  const workflow = 'task-flow-finish-outbox'
  const args = { key: 'DEV-FINISH-OUTBOX' }
  const context = {
    session: 'task-flow-finish-outbox',
    taskRecordId: 'task-DEV-FINISH-OUTBOX',
    taskStatusCategory: 'active',
  }
  installTaskFlowLifecycleWorkflow(d, workflow)

  const opened = composeWorkflowWithCursor(workflow, 'fixture', 'default', args, context, d, {}, {})
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(
    opened.cursor!.id,
  )
  nextWorkflowStep(workflow, 'fixture', 'default', args, 'finish', context, d, {}, testPorts)

  expectPendingFlowOutboxCleared(d)
})

test('abandoning a keyed stage enqueues the cleared task flow at its local revision', () => {
  const d = cursorDatabase()
  const workflow = 'task-flow-abandon-outbox'
  const args = { key: 'DEV-ABANDON-OUTBOX' }
  const context = {
    session: 'task-flow-abandon-outbox',
    taskRecordId: 'task-DEV-ABANDON-OUTBOX',
    taskStatusCategory: 'active',
  }
  installTaskFlowLifecycleWorkflow(d, workflow)

  composeWorkflowWithCursor(workflow, 'fixture', 'default', args, context, d, {}, {})
  abandonCursor(workflow, 'fixture', 'default', args, 'abandon', context, d)

  expectPendingFlowOutboxCleared(d)
})

test('one task flow refuses a second open stage and retains re-entry history', () => {
  const d = migratedTestDatabase()
  try {
    const projectId = newRecordId()
    d.query(
      `INSERT INTO project(record_id,name,path,canon,settings)
       VALUES (?,'fixture','/fixture',0,'{"trunk":"main"}')`,
    ).run(projectId)
    const workflowVersion = workflowVersionRecordId(d)
    const catalogueVersion = catalogueVersionRecordId(d)
    const insertStage = (workflow: string, flow: string) =>
      d
        .query<{ record_id: string; number: number }, string[]>(
          `INSERT INTO workflow_cursor
            (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,
             task_record_id,task_flow_record_id,instance_id,session_id,workflow_version_record_id,
             catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,
             total_steps,created_at,updated_at,enforcement)
           VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM workflow_cursor),'fixture',?,?,
                   'default','DEV-1','task-1',?,'',NULL,?,?,'{}','{}',0,'start','running',
                   '[]',NULL,1,'2026-11-01','2026-11-01','floors')
           RETURNING record_id,number`,
        )
        .get(newRecordId(), projectId, workflow, flow, workflowVersion, catalogueVersion)!
    const select = (workflow: string, statusCategory = 'active') =>
      selectTaskFlowStage(
        {
          project: 'fixture',
          taskRecordId: 'task-1',
          taskKey: 'DEV-1',
          statusCategory,
          workflow,
          mode: 'default',
        },
        d,
      )

    const flow = select('plan-task')
    const plan = insertStage('plan-task', flow.flowRecordId)
    attachTaskFlowStage(flow.flowRecordId, plan.record_id, d)
    expect(() => select('ship-task')).toThrow(
      `task DEV-1 already has open stage cursor ${plan.number} plan-task default; finish it with ${PLATFORM_SLUG} workflow next plan-task --cursor ${plan.number}, or drop it with ${PLATFORM_SLUG} workflow abandon plan-task --cursor ${plan.number}`,
    )

    d.query("UPDATE workflow_cursor SET state='done' WHERE record_id=?").run(plan.record_id)
    closeTaskFlowStage(plan.record_id, d)
    const shipFlow = select('ship-task')
    expect(shipFlow.flowRecordId).toBe(flow.flowRecordId)
    const ship = insertStage('ship-task', flow.flowRecordId)
    attachTaskFlowStage(flow.flowRecordId, ship.record_id, d)
    d.query("UPDATE workflow_cursor SET state='done' WHERE record_id=?").run(ship.record_id)
    closeTaskFlowStage(ship.record_id, d)

    expect(select('plan-task', 'done')).toMatchObject({
      flowRecordId: flow.flowRecordId,
      cursorRecordId: null,
    })
    vacateRetiredWorkflowKeySlot('fixture', 'plan-task', 'default', 'DEV-1', d)
    const replan = insertStage('plan-task', flow.flowRecordId)
    attachTaskFlowStage(flow.flowRecordId, replan.record_id, d)
    d.query("UPDATE workflow_cursor SET state='done' WHERE record_id=?").run(replan.record_id)
    closeTaskFlowStage(replan.record_id, d)
    expect(d.query('SELECT state FROM task_flow WHERE record_id=?').get(flow.flowRecordId)).toEqual(
      {
        state: 'done',
      },
    )
    expect(
      d
        .query(
          'SELECT workflow_slug,state,task_flow_record_id flow FROM workflow_cursor ORDER BY number',
        )
        .all(),
    ).toEqual([
      { workflow_slug: 'plan-task', state: 'done', flow: flow.flowRecordId },
      { workflow_slug: 'ship-task', state: 'done', flow: flow.flowRecordId },
      { workflow_slug: 'plan-task', state: 'done', flow: flow.flowRecordId },
    ])
  } finally {
    d.close()
  }
})

test('an unknown task status preserves the projected flow state', () => {
  const d = migratedTestDatabase()
  try {
    d.query(
      `INSERT INTO project(record_id,name,path,canon,settings)
       VALUES (?,'fixture','/fixture',0,'{"trunk":"main"}')`,
    ).run(newRecordId())
    const input = {
      project: 'fixture',
      taskRecordId: 'task-1',
      taskKey: 'DEV-1',
      workflow: 'ship-task',
      mode: 'default',
    }

    const flow = selectTaskFlowStage({ ...input, statusCategory: 'done' }, d)
    selectTaskFlowStage(input, d)

    expect(d.query('SELECT state FROM task_flow WHERE record_id=?').get(flow.flowRecordId)).toEqual(
      {
        state: 'done',
      },
    )
  } finally {
    d.close()
  }
})

test('keyed selection adopts an open cursor left without a flow by the backfill', () => {
  const d = migratedTestDatabase()
  try {
    const projectId = newRecordId()
    d.query(
      `INSERT INTO project(record_id,name,path,canon,settings)
       VALUES (?,'fixture','/fixture',0,'{"trunk":"main"}')`,
    ).run(projectId)
    const cursorRecordId = newRecordId()
    d.query(
      `INSERT INTO workflow_cursor
        (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,
         task_record_id,task_flow_record_id,instance_id,session_id,workflow_version_record_id,
         catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,
         total_steps,created_at,updated_at,enforcement)
       VALUES (?,1,'fixture',?,'plan-task','default','DEV-1','task-1',NULL,'',NULL,?,?,'{}',
               '{}',0,'start','running','[]',NULL,1,'2026-11-01','2026-11-01','floors')`,
    ).run(cursorRecordId, projectId, workflowVersionRecordId(d), catalogueVersionRecordId(d))

    const selected = selectWorkflowCursor(
      { project: 'fixture', workflow: 'plan-task', mode: 'default', key: 'DEV-1' },
      undefined,
      null,
      d,
      'task-1',
      'active',
    )!
    const flow = d
      .query('SELECT record_id,open_stage_cursor_record_id FROM task_flow WHERE task_record_id=?')
      .get('task-1') as { record_id: string; open_stage_cursor_record_id: string | null }

    expect(selected.task_flow_record_id).toBe(flow.record_id)
    expect(flow.open_stage_cursor_record_id).toBe(cursorRecordId)
    expect(() =>
      selectWorkflowCursor(
        { project: 'fixture', workflow: 'ship-task', mode: 'default', key: 'DEV-1' },
        undefined,
        null,
        d,
        'task-1',
        'active',
      ),
    ).toThrow('task DEV-1 already has open stage cursor 1 plan-task default')
  } finally {
    d.close()
  }
})
