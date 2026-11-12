import { expect, test } from 'bun:test'
import {
  encodeTaskFlowStageListCursor,
  taskFlowStageListQuerySchema,
} from './record-task-flow-contract.ts'

const ID = '00000000-0000-4000-8000-000000000001'

test.each([
  { workflow: 'fix-defect' },
  { mode: 'default' },
  { workflowKey: 'DEV-2234' },
  { keyless: true },
  { primaryInstance: true },
  { taskId: ID },
  { unlinked: true },
])('task-flow stage-list filter satisfies the required-filter rule: %o', (filter) => {
  expect(taskFlowStageListQuerySchema.safeParse(filter).success).toBeTrue()
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
