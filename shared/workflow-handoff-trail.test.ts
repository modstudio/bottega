import { expect, test } from 'bun:test'
import { workflowHandoffTrail } from './workflow-handoff-trail.ts'

test('handoff trail names the allocated successor and marks every remaining step not run', () => {
  expect(
    workflowHandoffTrail({
      closed: [{ n: 1, slug: 'first', note: 'done', at: 'earlier' }],
      current: { n: 2, slug: 'build' },
      remaining: [{ n: 3, slug: 'land' }],
      targetWorkflow: 'ship-task',
      successorNumber: 42,
      reason: 'implementation is ready',
      at: 'now',
    }),
  ).toEqual([
    { n: 1, slug: 'first', note: 'done', at: 'earlier' },
    {
      n: 2,
      slug: 'build',
      note: 'handed off to ship-task (cursor 42): implementation is ready',
      at: 'now',
    },
    { n: 3, slug: 'land', note: 'not run: handed off', at: 'now' },
  ])
})
