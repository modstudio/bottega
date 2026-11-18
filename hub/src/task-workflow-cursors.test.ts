import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
import { TaskClosedWithResidueError } from './task-closed-residue.ts'
import type { TaskRow } from './task-row.ts'
import {
  abandonPlannedTaskCursors,
  type OpenTaskWorkflowCursor,
  planOpenTaskCursorClose,
} from './task-workflow-cursors.ts'

const closed = { project: PLATFORM_NAME, key: 'DEV-2428' } as TaskRow
const cursor = (
  id: number,
  values: Partial<OpenTaskWorkflowCursor> = {},
): OpenTaskWorkflowCursor => ({
  id,
  record_id: `01a1ed7c-1111-7111-8111-${String(id).padStart(12, '0')}`,
  project: PLATFORM_NAME,
  workflow_slug: 'ship-task',
  workflow_key: 'DEV-2428',
  session_id: `foreign-session-${id}`,
  live_runs: [],
  ...values,
})

const closeCursors = async (
  cursors: OpenTaskWorkflowCursor[],
  dependencies: Omit<Parameters<typeof planOpenTaskCursorClose>[3], 'list' | 'callingSession'>,
) =>
  abandonPlannedTaskCursors(
    await planOpenTaskCursorClose(PLATFORM_NAME, 'DEV-2428', 'done', {
      ...dependencies,
      callingSession: 'calling-session',
      list: async () => cursors,
    }),
    closed,
  )

describe('task workflow cursor close', () => {
  test('an abandon failure names the failing and later cursors as residue', async () => {
    const operation = closeCursors([cursor(41), cursor(42), cursor(43)], {
      abandon: async (candidate: OpenTaskWorkflowCursor) => {
        if (candidate.id === 42) throw new Error('cursor store unavailable')
      },
    })

    const error = await operation.catch((cause) => cause)
    expect(error).toBeInstanceOf(TaskClosedWithResidueError)
    expect(error.task).toBe(closed)
    expect(error.message).toBe(
      `task DEV-2428 is closed; workflow cursor cleanup did not finish: cursor store unavailable\n` +
        `clear it with: ${PLATFORM_SLUG} workflow abandon ship-task --cursor 42 --project ${PLATFORM_NAME} --owner-session foreign-session-42 --reason "task DEV-2428 closed (done)"\n` +
        `clear it with: ${PLATFORM_SLUG} workflow abandon ship-task --cursor 43 --project ${PLATFORM_NAME} --owner-session foreign-session-43 --reason "task DEV-2428 closed (done)"`,
    )
  })

  test('a reporting failure names only cursors that remain open', async () => {
    const operation = closeCursors([cursor(41), cursor(42)], {
      abandon: async () => {},
      onAbandoned: () => {
        throw new Error('reporting callback blew up')
      },
    })

    const error = await operation.catch((cause) => cause)
    expect(error).toBeInstanceOf(TaskClosedWithResidueError)
    expect(error.task).toBe(closed)
    expect(error.message).toBe(
      `task DEV-2428 is closed; workflow cursor cleanup did not finish: reporting callback blew up\n` +
        `clear it with: ${PLATFORM_SLUG} workflow abandon ship-task --cursor 42 --project ${PLATFORM_NAME} --owner-session foreign-session-42 --reason "task DEV-2428 closed (done)"`,
    )
  })

  test('a reporting failure after the last abandon rethrows the original error', async () => {
    const callbackError = new Error('reporting callback blew up')
    const operation = closeCursors([cursor(41)], {
      abandon: async () => {},
      onAbandoned: () => {
        throw callbackError
      },
    })

    expect(await operation.catch((cause) => cause)).toBe(callbackError)
  })
})
