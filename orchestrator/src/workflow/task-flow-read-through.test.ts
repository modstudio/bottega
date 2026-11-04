import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { cacheHostedTaskFlow, decideTaskFlowReadThrough } from './task-flow-read-through.ts'

test('read-through picks local, hosted, or refresh from stage revisions', () => {
  expect(decideTaskFlowReadThrough({ localStageRevision: 4, hostedStageRevision: null })).toBe(
    'local',
  )
  expect(decideTaskFlowReadThrough({ localStageRevision: null, hostedStageRevision: 1 })).toBe(
    'hosted',
  )
  expect(decideTaskFlowReadThrough({ localStageRevision: 4, hostedStageRevision: 5 })).toBe(
    'refresh',
  )
  expect(decideTaskFlowReadThrough({ localStageRevision: 5, hostedStageRevision: 5 })).toBe('local')
})

test('hosted flow and open stage cache as one selectable local cursor', () => {
  const database = db()
  const projectId = newRecordId()
  upsertProject({
    recordId: projectId,
    name: 'read-through-fixture',
    path: '/tmp/read-through-fixture',
  })
  const workflow = database
    .query<{ record_id: string }, []>('SELECT record_id FROM workflow_version LIMIT 1')
    .get()!
  const catalogue = database
    .query<{ record_id: string }, []>('SELECT record_id FROM step_catalogue_version LIMIT 1')
    .get()!
  const flowId = newRecordId(),
    stageId = newRecordId(),
    taskId = newRecordId()
  const machineA = newRecordId(),
    machineB = newRecordId()
  cacheHostedTaskFlow(database, 'DEV-2098', {
    flow: {
      id: flowId,
      projectId,
      taskId,
      state: 'open',
      openStageRecordId: stageId,
      openingMachineId: machineA,
      updatedMachineId: machineB,
      revision: 3,
      createdAt: '2026-11-03T10:00:00.000Z',
      updatedAt: '2026-11-03T11:00:00.000Z',
    },
    stage: {
      id: stageId,
      flowRecordId: flowId,
      workflow: 'fix-defect',
      mode: 'default',
      workflowVersionId: workflow.record_id,
      catalogueVersionId: catalogue.record_id,
      arguments: { key: 'DEV-2098' },
      activeOrdinal: 1,
      activeSlug: 'implement',
      state: 'running',
      closedStepNotes: [],
      totalSteps: 3,
      openedMachineId: machineA,
      takenOverFromMachineId: machineA,
      lastAdvancedMachineId: machineB,
      revision: 4,
      createdAt: '2026-11-03T10:00:00.000Z',
      updatedAt: '2026-11-03T11:00:00.000Z',
      holder: { id: machineB, displayName: 'Machine B' },
    },
  })
  expect(
    database
      .query('SELECT record_id,open_stage_cursor_record_id FROM task_flow WHERE record_id=?')
      .get(flowId),
  ).toEqual({ record_id: flowId, open_stage_cursor_record_id: stageId })
  expect(
    database
      .query(
        'SELECT task_flow_record_id,revision,last_advanced_machine_id FROM workflow_cursor WHERE record_id=?',
      )
      .get(stageId),
  ).toEqual({ task_flow_record_id: flowId, revision: 4, last_advanced_machine_id: machineB })
})
