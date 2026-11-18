import { expect, test } from 'bun:test'
import { taskFlowRequestId, workflowHandoffTrail } from './record-task-flow-write-contract.ts'

test('task-flow request ids are stable and distinguish intent names and parts', () => {
  const first = taskFlowRequestId('stage-update', ['stage-a', '3'])
  expect(first).toBe(taskFlowRequestId('stage-update', ['stage-a', '3']))
  expect(first).not.toBe(taskFlowRequestId('advance', ['stage-a', '3']))
  expect(first).not.toBe(taskFlowRequestId('stage-update', ['stage-a', '4']))
})

test('handoff trail names the allocated successor and marks every remaining step not run', () => {
  expect(
    workflowHandoffTrail({
      closed: [{ n: 1, slug: 'first', note: 'done', at: 'earlier' }],
      current: { n: 2, slug: 'current' },
      remaining: [
        { n: 3, slug: 'later' },
        { n: 4, slug: 'last' },
      ],
      targetWorkflow: 'ship-task',
      successorNumber: 42,
      reason: 'implementation is ready',
      at: 'now',
    }),
  ).toEqual([
    { n: 1, slug: 'first', note: 'done', at: 'earlier' },
    {
      n: 2,
      slug: 'current',
      note: 'handed off to ship-task (cursor 42): implementation is ready',
      at: 'now',
    },
    { n: 3, slug: 'later', note: 'not run: handed off', at: 'now' },
    { n: 4, slug: 'last', note: 'not run: handed off', at: 'now' },
  ])
})
