import { expect, test } from 'bun:test'
import { taskFlowReadStore } from './task-flow-store.ts'
import { composeWorkflowWithCursor } from './workflow-cursor.ts'
import { args, context, database } from './workflow-cursor-test.fixture.ts'
import { renderWorkflowComposition } from './workflow-render.ts'
import type { TaskCursorClaimPorts } from './workflow-task-claim.ts'

const rejectingTake: TaskCursorClaimPorts = {
  take: async () => {
    throw new Error('claim service refused the take')
  },
  release: async () => ({ released: 0 }),
}

test('a failed claim take abandons a freshly composed cursor and rejects', async () => {
  const d = database()

  await expect(
    composeWorkflowWithCursor(
      'flow',
      'fixture',
      'default',
      args,
      context,
      d,
      {},
      {},
      undefined,
      rejectingTake,
    ),
  ).rejects.toThrow('claim service refused the take')

  expect(
    (await taskFlowReadStore(d).listOpenStages({ project: 'fixture' })).filter(
      (stage) => stage.workflow_key === args.key,
    ),
  ).toEqual([])
})

test('a failed claim take after reuse keeps the cursor and returns the retry warning', async () => {
  const d = database()
  await composeWorkflowWithCursor('flow', 'fixture', 'default', args, context, d, {}, {})

  const resumed = await composeWorkflowWithCursor(
    'flow',
    'fixture',
    'default',
    args,
    { ...context, session: 'session-two' },
    d,
    {},
    {},
    undefined,
    rejectingTake,
  )

  expect(resumed.cursor?.opened).toBeFalse()
  expect(renderWorkflowComposition(resumed)).toContain(
    'warning: task cursor moved but its claim did not move: claim service refused the take; run workflow next for DEV-822 to retake it',
  )
  expect(
    (await taskFlowReadStore(d).listOpenStages({ project: 'fixture' })).find(
      (stage) => stage.workflow_key === args.key,
    ),
  ).toMatchObject({ session_id: 'session-two' })
})
