import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../shared/brand.ts'
import {
  abandonPlannedTaskCursors,
  type OpenTaskWorkflowCursor,
  planOpenTaskCursorClose,
} from './task-workflow-cursors.ts'

const cursor = (values: Partial<OpenTaskWorkflowCursor> = {}): OpenTaskWorkflowCursor => ({
  id: 41,
  record_id: '01a1ed7c-1111-7111-8111-111111111111',
  project: PLATFORM_NAME,
  workflow_slug: 'ship-task',
  workflow_key: 'DEV-2428',
  session_id: 'foreign-session',
  live_runs: [],
  ...values,
})

describe('task workflow cursor close', () => {
  const closeCursors = async (
    status: string,
    dependencies: Parameters<typeof planOpenTaskCursorClose>[3],
  ) =>
    abandonPlannedTaskCursors(
      await planOpenTaskCursorClose(PLATFORM_NAME, 'DEV-2428', status, dependencies),
    )

  test('abandons a foreign cursor with the closed-task reason and owner acknowledgement', async () => {
    const calls: Array<{ reason: string; owner: string | undefined }> = []
    const abandoned: Array<{ number: number; workflow: string; reason: string }> = []
    await closeCursors('done', {
      callingSession: 'calling-session',
      list: async () => [cursor()],
      abandon: async (_cursor, reason, owner) => calls.push({ reason, owner }),
      onAbandoned: (result) => abandoned.push(result),
    })

    expect(calls).toEqual([{ reason: 'task DEV-2428 closed (done)', owner: 'foreign-session' }])
    expect(abandoned).toEqual([
      { number: 41, workflow: 'ship-task', reason: 'task DEV-2428 closed (done)' },
    ])
  })
})
