import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { awaitWorkflowRuling, composeWorkflowWithCursor } from './workflow-cursor.ts'
import { ruleWorkflow } from './workflow-cursor-ruling.ts'
import {
  abandonCursor,
  database as cursorDatabase,
  selectAndNextWorkflowStep as nextWorkflowStep,
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

function installKeylessTaskFlowWorkflow(d: ReturnType<typeof cursorDatabase>, slug: string): void {
  const draft = setWorkflowLocal(
    slug,
    {
      title: `${slug} fixture`,
      description: 'Exercises task adoption into a task flow.',
      arguments: [{ name: 'key', required: false, description: 'Task key.' }],
      modes: [{ slug: 'default', title: 'Default', default: true, steps: ['score', 'complete'] }],
    },
    'task-flow adoption fixture',
    'test',
    d,
  )
  promoteWorkflowLocal(slug, draft.n, 'publish task-flow adoption fixture', 'test', d)
}

test('cursor commands attach, refuse overlap, finish, re-enter, and abandon task stages', async () => {
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

  const opened = await composeWorkflowWithCursor(
    plan,
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {},
  )
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
  await expect(
    composeWorkflowWithCursor(ship, 'fixture', 'default', args, context, d, {}, {}),
  ).rejects.toThrow(`task DEV-FLOW already has open stage cursor ${planCursor} ${plan} default`)

  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(planCursor)
  await nextWorkflowStep(
    plan,
    'fixture',
    'default',
    args,
    'plan finished',
    context,
    d,
    {},
    testPorts,
  )
  expect(pointers(planCursor).openStage).toBeNull()

  const reentered = await composeWorkflowWithCursor(
    ship,
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {},
  )
  const shipCursor = reentered.cursor!.id
  const shipPointers = pointers(shipCursor)
  expect(reentered.cursor?.opened).toBe(true)
  expect(shipPointers).toMatchObject({
    openStage: shipPointers.cursorId,
    cursorFlow: shipPointers.flowId,
  })

  await abandonCursor(ship, 'fixture', 'default', args, 'stage no longer needed', context, d)
  expect(d.query('SELECT open_stage_cursor_record_id openStage FROM task_flow').get()).toEqual({
    openStage: null,
  })
})

test('task-flow mutations never enqueue flow or stage rows', async () => {
  const d = cursorDatabase()
  const workflow = 'task-flow-outbox'
  installTaskFlowLifecycleWorkflow(d, workflow, ['score', 'complete'])
  const args = { key: 'DEV-OUTBOX' }
  const context = {
    session: 'task-flow-outbox',
    taskRecordId: 'task-DEV-OUTBOX',
    taskStatusCategory: 'active',
  }

  const opened = await composeWorkflowWithCursor(
    workflow,
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {},
  )
  const cursor = opened.cursor!.id
  expect(d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%'").all()).toEqual([])

  d.query("DELETE FROM outbox WHERE kind LIKE 'task_flow%'").run()
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(cursor)
  await nextWorkflowStep(workflow, 'fixture', 'default', args, 'advance', context, d, {}, testPorts)
  expect(d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%'").all()).toEqual([])

  d.query("DELETE FROM outbox WHERE kind LIKE 'task_flow%'").run()
  const tasklessWorkflow = 'task-flow-taskless'
  installTaskFlowLifecycleWorkflow(d, tasklessWorkflow)
  await composeWorkflowWithCursor(
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

test('answering a keyed stage ruling writes no task-flow outbox row', async () => {
  const d = cursorDatabase()
  const workflow = 'task-flow-ruling-outbox'
  const args = { key: 'DEV-RULING-OUTBOX' }
  const context = {
    session: 'task-flow-ruling-outbox',
    taskRecordId: 'task-DEV-RULING-OUTBOX',
    taskStatusCategory: 'active',
  }
  installTaskFlowLifecycleWorkflow(d, workflow)
  await composeWorkflowWithCursor(workflow, 'fixture', 'default', args, context, d, {}, {})
  await awaitWorkflowRuling(workflow, 'fixture', 'default', args, 'Proceed?', context, d, () => {})

  await ruleWorkflow(workflow, 'fixture', 'default', args, 'Proceed.', true, 'mcp', context, d)

  expect(d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%'").all()).toEqual([])
})

test('task adoption attaches a local flow and later advance writes no outbox row', async () => {
  const d = cursorDatabase()
  const workflow = 'task-flow-adoption-outbox'
  installKeylessTaskFlowWorkflow(d, workflow)
  const opened = await composeWorkflowWithCursor(
    workflow,
    'fixture',
    'default',
    {},
    { session: 'task-flow-adoption-outbox' },
    d,
    {},
    {},
  )
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(
    opened.cursor!.id,
  )
  const adoptedContext = {
    session: 'task-flow-adoption-outbox',
    taskRecordId: 'task-DEV-ADOPT-FLOW',
  }
  await nextWorkflowStep(
    workflow,
    'fixture',
    'default',
    {},
    'adopt',
    adoptedContext,
    d,
    { task: 'DEV-ADOPT-FLOW' },
    testPorts,
    opened.cursor!.id,
  )
  d.query("DELETE FROM outbox WHERE kind LIKE 'task_flow%'").run()

  await nextWorkflowStep(
    workflow,
    'fixture',
    'default',
    {},
    'finish',
    adoptedContext,
    d,
    {},
    testPorts,
    opened.cursor!.id,
  )

  expect(
    d
      .query('SELECT task_flow_record_id FROM workflow_cursor WHERE number=?')
      .get(opened.cursor!.id),
  ).toEqual({ task_flow_record_id: expect.any(String) })
  expect(d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%'").all()).toEqual([])
})

test('task adoption refuses when that task already has another open stage', async () => {
  const d = cursorDatabase()
  installTaskFlowLifecycleWorkflow(d, 'task-flow-existing-stage')
  installKeylessTaskFlowWorkflow(d, 'task-flow-adoption-conflict')
  const context = {
    session: 'task-flow-adoption-conflict',
    taskRecordId: 'task-DEV-ADOPT-CONFLICT',
  }
  await composeWorkflowWithCursor(
    'task-flow-existing-stage',
    'fixture',
    'default',
    { key: 'DEV-ADOPT-CONFLICT' },
    context,
    d,
    {},
    {},
  )
  const keyless = await composeWorkflowWithCursor(
    'task-flow-adoption-conflict',
    'fixture',
    'default',
    {},
    { session: context.session },
    d,
    {},
    {},
  )
  d.query("UPDATE workflow_cursor SET enforcement='note-only'").run()

  await expect(
    nextWorkflowStep(
      'task-flow-adoption-conflict',
      'fixture',
      'default',
      {},
      'adopt',
      context,
      d,
      { task: 'DEV-ADOPT-CONFLICT' },
      testPorts,
      keyless.cursor!.id,
    ),
  ).rejects.toThrow('task DEV-ADOPT-CONFLICT already has open stage cursor')
})

test('finishing a keyed stage clears the local flow without enqueueing', async () => {
  const d = cursorDatabase()
  const workflow = 'task-flow-finish-outbox'
  const args = { key: 'DEV-FINISH-OUTBOX' }
  const context = {
    session: 'task-flow-finish-outbox',
    taskRecordId: 'task-DEV-FINISH-OUTBOX',
    taskStatusCategory: 'active',
  }
  installTaskFlowLifecycleWorkflow(d, workflow)

  const opened = await composeWorkflowWithCursor(
    workflow,
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {},
  )
  d.query("UPDATE workflow_cursor SET enforcement='note-only' WHERE number=?").run(
    opened.cursor!.id,
  )
  await nextWorkflowStep(workflow, 'fixture', 'default', args, 'finish', context, d, {}, testPorts)

  expect(d.query('SELECT open_stage_cursor_record_id FROM task_flow').get()).toEqual({
    open_stage_cursor_record_id: null,
  })
  expect(d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%'").all()).toEqual([])
})

test('abandoning a keyed stage clears the local flow without enqueueing', async () => {
  const d = cursorDatabase()
  const workflow = 'task-flow-abandon-outbox'
  const args = { key: 'DEV-ABANDON-OUTBOX' }
  const context = {
    session: 'task-flow-abandon-outbox',
    taskRecordId: 'task-DEV-ABANDON-OUTBOX',
    taskStatusCategory: 'active',
  }
  installTaskFlowLifecycleWorkflow(d, workflow)

  await composeWorkflowWithCursor(workflow, 'fixture', 'default', args, context, d, {}, {})
  await abandonCursor(workflow, 'fixture', 'default', args, 'abandon', context, d)

  expect(d.query('SELECT open_stage_cursor_record_id FROM task_flow').get()).toEqual({
    open_stage_cursor_record_id: null,
  })
  expect(d.query("SELECT kind FROM outbox WHERE kind LIKE 'task_flow%'").all()).toEqual([])
})

test('unreachable takeover refuses without changing takeover or revision', async () => {
  const d = cursorDatabase()
  const workflow = 'task-flow-unreachable-takeover'
  const args = { key: 'DEV-UNREACHABLE' }
  const baseContext = {
    session: 'task-flow-unreachable',
    taskRecordId: 'task-DEV-UNREACHABLE',
    taskStatusCategory: 'active',
  }
  installTaskFlowLifecycleWorkflow(d, workflow, ['score', 'complete'])
  const opened = await composeWorkflowWithCursor(
    workflow,
    'fixture',
    'default',
    args,
    baseContext,
    d,
    {},
    {},
  )
  const holder = newRecordId()
  d.query('UPDATE workflow_cursor SET last_advanced_machine_id=? WHERE number=?').run(
    holder,
    opened.cursor!.id,
  )
  const before = d
    .query('SELECT taken_over_from_machine_id,revision FROM workflow_cursor WHERE number=?')
    .get(opened.cursor!.id)

  expect(() =>
    nextWorkflowStep(
      workflow,
      'fixture',
      'default',
      args,
      'advance',
      {
        ...baseContext,
        taskFlowRead: { status: 'unreachable', remedy: 'sign in to the record' },
      },
      d,
      {},
      testPorts,
    ),
  ).toThrow(`workflow stage is held by ${holder}; sign in to the record`)
  expect(
    d
      .query('SELECT taken_over_from_machine_id,revision FROM workflow_cursor WHERE number=?')
      .get(opened.cursor!.id),
  ).toEqual(before)
})

test('takeover without a keyed record read refuses with the --key remedy', async () => {
  const d = cursorDatabase()
  const workflow = 'task-flow-not-attempted-takeover'
  const args = { key: 'DEV-NOT-ATTEMPTED' }
  const context = {
    session: 'task-flow-not-attempted',
    taskRecordId: 'task-DEV-NOT-ATTEMPTED',
    taskStatusCategory: 'active',
  }
  installTaskFlowLifecycleWorkflow(d, workflow, ['score', 'complete'])
  const opened = await composeWorkflowWithCursor(
    workflow,
    'fixture',
    'default',
    args,
    context,
    d,
    {},
    {},
  )
  const holder = newRecordId()
  d.query('UPDATE workflow_cursor SET last_advanced_machine_id=? WHERE number=?').run(
    holder,
    opened.cursor!.id,
  )

  expect(() =>
    nextWorkflowStep(workflow, 'fixture', 'default', args, 'advance', context, d, {}, testPorts),
  ).toThrow(
    `workflow stage is held by ${holder}; the stage was last advanced by this holder and was not read from the record; re-run with --key DEV-NOT-ATTEMPTED`,
  )
})

test('a takeover refused for a missing close note leaves the cursor untouched', async () => {
  const d = cursorDatabase()
  const workflow = 'task-flow-takeover-missing-note'
  const args = { key: 'DEV-MISSING-NOTE' }
  const baseContext = {
    session: 'task-flow-missing-note',
    taskRecordId: 'task-DEV-MISSING-NOTE',
    taskStatusCategory: 'active',
  }
  installTaskFlowLifecycleWorkflow(d, workflow, ['score', 'complete'])
  const opened = await composeWorkflowWithCursor(
    workflow,
    'fixture',
    'default',
    args,
    baseContext,
    d,
    {},
    {},
  )
  const holder = newRecordId()
  d.query('UPDATE workflow_cursor SET last_advanced_machine_id=? WHERE number=?').run(
    holder,
    opened.cursor!.id,
  )
  const before = d
    .query('SELECT taken_over_from_machine_id,revision FROM workflow_cursor WHERE number=?')
    .get(opened.cursor!.id)

  expect(() =>
    nextWorkflowStep(
      workflow,
      'fixture',
      'default',
      args,
      undefined,
      {
        ...baseContext,
        taskFlowRead: { status: 'reachable', holder: { id: holder, displayName: 'Machine B' } },
      },
      d,
      {},
      testPorts,
    ),
  ).toThrow('--note is required')
  expect(
    d
      .query('SELECT taken_over_from_machine_id,revision FROM workflow_cursor WHERE number=?')
      .get(opened.cursor!.id),
  ).toEqual(before)
})
