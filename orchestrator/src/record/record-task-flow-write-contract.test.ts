import { expect, test } from 'bun:test'
import { validate as validateUuid } from 'uuid'
import { taskFlowRequestId } from './record-task-flow-write-contract.ts'

test('task-flow request ids are stable namespaced UUIDs over ordered caller facts', () => {
  const parts = ['flow-a', '1', 'stage-b', '4']
  const first = taskFlowRequestId('advance', parts)
  expect(validateUuid(first)).toBe(true)
  expect(taskFlowRequestId('advance', parts)).toBe(first)
  expect(taskFlowRequestId('abandon', parts)).not.toBe(first)
  expect(taskFlowRequestId('advance', [...parts].reverse())).not.toBe(first)
})
