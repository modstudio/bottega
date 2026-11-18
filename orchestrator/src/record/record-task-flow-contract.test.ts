import { expect, test } from 'bun:test'
import { encodeTaskFlowStageListCursor } from './record-cursor.ts'
import {
  hostedTaskFlowTextByIdSchema,
  TASK_FLOW_CLOSED_STAGE_STATES_SQL,
  TASK_FLOW_OPEN_STAGE_STATES_SQL,
  taskFlowStageListQuerySchema,
} from './record-task-flow-contract.ts'

const ID = '00000000-0000-4000-8000-000000000001'
const RUNNING_SQL = "'running'"
const AWAITING_RULING_SQL = "'awaiting-ruling'"
const DONE_SQL = "'done'"
const ABANDONED_SQL = "'abandoned'"

test('task-flow stage-state SQL lists preserve the indexed predicate text', () => {
  expect(TASK_FLOW_CLOSED_STAGE_STATES_SQL).toBe([DONE_SQL, ABANDONED_SQL].join(','))
  expect(TASK_FLOW_OPEN_STAGE_STATES_SQL).toBe([RUNNING_SQL, AWAITING_RULING_SQL].join(','))
})

test('task-flow stage-list query refuses a malformed cursor', () => {
  const parsed = taskFlowStageListQuerySchema.safeParse({ workflow: 'fix-defect', cursor: 'bad' })
  expect(parsed.success).toBeFalse()
  expect(parsed.error?.issues).toContainEqual(
    expect.objectContaining({ message: 'invalid stage-list cursor' }),
  )
})

test('task-flow stage-list query refuses a cursor from another order', () => {
  const cursor = encodeTaskFlowStageListCursor({
    order: 'project',
    projectName: 'project-a',
    number: 2,
    id: ID,
  })
  const parsed = taskFlowStageListQuerySchema.safeParse({
    workflow: 'fix-defect',
    order: 'newest',
    cursor,
  })
  expect(parsed.success).toBeFalse()
  expect(parsed.error?.issues).toContainEqual(
    expect.objectContaining({ message: 'cursor order does not match request order' }),
  )
})

test('task-flow by-id client schema accepts a response without space_id', () => {
  expect(
    hostedTaskFlowTextByIdSchema.parse({
      text: {
        id: ID,
        stageRecordId: ID,
        stepOrdinal: 0,
        stepSlug: 'plan',
        body: 'legacy hosted response',
        createdAt: '2026-11-17T00:00:00.000Z',
      },
      stage: { id: ID, number: 1 },
      copy: null,
    }),
  ).not.toHaveProperty('space_id')
})

test('task-flow text client schema accepts a durable copy after live text removal', () => {
  expect(
    hostedTaskFlowTextByIdSchema.parse({
      text: null,
      stage: { id: ID, number: 1 },
      copy: {
        id: ID,
        workflowTextRecordId: ID,
        stageRecordId: ID,
        taskDocumentReference: 'task:DEV-2416/guard',
        copiedAt: '2026-11-17T00:00:00.000Z',
      },
    }),
  ).toMatchObject({ text: null, copy: { taskDocumentReference: 'task:DEV-2416/guard' } })
})
