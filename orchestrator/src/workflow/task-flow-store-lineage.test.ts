import { expect, test } from 'bun:test'
import { createMemoryRecordApiClient } from '../../test/fixtures/record-api.ts'
import {
  ABANDONED_STAGE_ID,
  CATALOGUE_VERSION_ID,
  CHILD_FLOW_ID,
  CHILD_STAGE_ID,
  database,
  FLOW_ID,
  hostedStage,
  MACHINE_ID,
  PROJECT_ID,
  WORKFLOW_VERSION_ID,
} from './task-flow-store-record.fixture.ts'
import { recordTaskFlowReadStore } from './task-flow-store-record.ts'
import { sqliteTaskFlowReadStore } from './task-flow-store-sqlite.ts'

test('flow lineage reads this stage and ancestor flows, never sibling stages', async () => {
  const d = database()
  d.query(
    `INSERT INTO task_flow
     (record_id,task_record_id,project_record_id,state,open_stage_cursor_record_id,
      parent_flow_record_id,created_at,updated_at,opening_machine_id,updated_machine_id,revision)
     VALUES (?,NULL,?,'open',NULL,?, ?,?,?,?,1)`,
  ).run(
    CHILD_FLOW_ID,
    PROJECT_ID,
    FLOW_ID,
    '2026-11-12T00:00:00.000Z',
    '2026-11-12T00:00:00.000Z',
    MACHINE_ID,
    MACHINE_ID,
  )
  const insertStage = d.query(
    `INSERT INTO workflow_cursor
     (record_id,number,project,project_record_id,workflow_slug,mode_slug,workflow_key,
      task_record_id,task_flow_record_id,instance_id,session_id,workflow_version_record_id,
      catalogue_version_record_id,args,autonomy,ordinal,step_slug,state,closed,question,total_steps,
      created_at,updated_at,enforcement,opened_machine_id,last_advanced_machine_id,revision)
     VALUES (?,?, 'fixture',?,'flow','default','',NULL,?,?,?, ?,?,'{}','guided',0,'plan',?,
             '[]',NULL,2,?,?,'floors',?,?,1)`,
  )
  for (const [id, number, state, instance] of [
    [ABANDONED_STAGE_ID, 2, 'abandoned', '#2'],
    [CHILD_STAGE_ID, 3, 'running', ''],
  ] as const)
    insertStage.run(
      id,
      number,
      PROJECT_ID,
      CHILD_FLOW_ID,
      instance,
      'session-a',
      WORKFLOW_VERSION_ID,
      CATALOGUE_VERSION_ID,
      state,
      '2026-11-12T00:00:00.000Z',
      '2026-11-12T00:00:00.000Z',
      MACHINE_ID,
      MACHINE_ID,
    )
  d.query('UPDATE task_flow SET open_stage_cursor_record_id=? WHERE record_id=?').run(
    CHILD_STAGE_ID,
    CHILD_FLOW_ID,
  )
  const insertText = d.query(
    `INSERT INTO workflow_step_text
     (record_id,cursor_record_id,step_ordinal,step_slug,body,created_at) VALUES (?,?,?,?,?,?)`,
  )
  insertText.run(
    '00000000-0000-4000-8000-000000000018',
    ABANDONED_STAGE_ID,
    0,
    'plan',
    'abandoned text',
    '2026-11-12T00:00:00.000Z',
  )
  insertText.run(
    '00000000-0000-4000-8000-000000000019',
    CHILD_STAGE_ID,
    0,
    'plan',
    'child text',
    '2026-11-12T00:00:00.000Z',
  )

  const root = hostedStage()
  const abandoned = hostedStage({
    taskless: true,
    number: 2,
    stageId: ABANDONED_STAGE_ID,
    flowId: CHILD_FLOW_ID,
  })
  const child = hostedStage({
    taskless: true,
    number: 3,
    stageId: CHILD_STAGE_ID,
    flowId: CHILD_FLOW_ID,
  })
  for (const row of [abandoned, child]) {
    row.flow.parentFlowRecordId = FLOW_ID
    row.flow.openStageRecordId = CHILD_STAGE_ID
  }
  abandoned.stage.state = 'abandoned'
  abandoned.stage.stepTexts = [
    {
      id: '00000000-0000-4000-8000-000000000018',
      stageRecordId: ABANDONED_STAGE_ID,
      stepOrdinal: 0,
      stepSlug: 'plan',
      body: 'abandoned text',
      createdAt: '2026-11-12T00:00:00.000Z',
    },
  ]
  child.stage.stepTexts = [
    {
      id: '00000000-0000-4000-8000-000000000019',
      stageRecordId: CHILD_STAGE_ID,
      stepOrdinal: 0,
      stepSlug: 'plan',
      body: 'child text',
      createdAt: '2026-11-12T00:00:00.000Z',
    },
  ]
  const local = sqliteTaskFlowReadStore(d)
  const hosted = recordTaskFlowReadStore(
    d,
    createMemoryRecordApiClient({ taskFlowStages: [root, abandoned, child] }),
  )
  for (const store of [local, hosted])
    expect(
      (await store.textsForFlowLineage(CHILD_FLOW_ID, CHILD_STAGE_ID)).map(({ body }) => body),
    ).toEqual(['fixture text', 'child text'])
})
