import { expect, test } from 'bun:test'
import { taskFlowRequestId } from './record-task-flow-write-contract.ts'

test('task-flow request ids are stable and distinguish intent names and parts', () => {
  const first = taskFlowRequestId('stage-update', ['stage-a', '3'])
  expect(first).toBe(taskFlowRequestId('stage-update', ['stage-a', '3']))
  expect(first).not.toBe(taskFlowRequestId('advance', ['stage-a', '3']))
  expect(first).not.toBe(taskFlowRequestId('stage-update', ['stage-a', '4']))
})
