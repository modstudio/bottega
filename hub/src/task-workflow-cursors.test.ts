import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
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
    const abandoned = await closeCursors('done', {
      callingSession: 'calling-session',
      list: async () => [cursor()],
      abandon: async (_cursor, reason, owner) => calls.push({ reason, owner }),
    })

    expect(calls).toEqual([{ reason: 'task DEV-2428 closed (done)', owner: 'foreign-session' }])
    expect(abandoned).toEqual([
      { number: 41, workflow: 'ship-task', reason: 'task DEV-2428 closed (done)' },
    ])
  })

  test("leaves the calling session's cursor open", async () => {
    let abandonCalls = 0
    const abandoned = await closeCursors('done', {
      callingSession: 'calling-session',
      list: async () => [cursor({ session_id: 'calling-session' })],
      abandon: async () => {
        abandonCalls += 1
      },
    })

    expect(abandonCalls).toBe(0)
    expect(abandoned).toEqual([])
  })

  test('refuses every abandonment before mutation when a cursor has a live run', async () => {
    let abandonCalls = 0
    await expect(
      closeCursors('dropped', {
        callingSession: null,
        list: async () => [
          cursor({
            live_runs: [{ number: 37503, record_id: '01a1ed7c-2222-7222-8222-222222222222' }],
          }),
          cursor({ id: 42, session_id: null }),
        ],
        abandon: async () => {
          abandonCalls += 1
        },
      }),
    ).rejects.toThrow(`clear it with: ${PLATFORM_SLUG} run stop 37503`)
    expect(abandonCalls).toBe(0)
  })
})
