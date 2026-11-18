import { describe, expect, test } from 'bun:test'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../shared/brand.ts'
import { UNATTRIBUTED } from './task-attribution.ts'
import { closeThenPrune } from './task-close.ts'
import { decideTaskClose } from './task-close-decision.ts'
import { TaskClosedWithResidueError } from './task-closed-residue.ts'
import type { TaskRow } from './task-row.ts'
import type { OpenTaskWorkflowCursor } from './task-workflow-cursors.ts'

const closedTask = { project: PLATFORM_NAME, key: 'DEV-1' } as TaskRow
const cursorDependencies = {
  project: () => PLATFORM_NAME,
  listCursors: async () => [],
}

describe('task close decision', () => {
  test('closes when every branch is landed', () => {
    expect(decideTaskClose({ available: true, unlanded: [] })).toEqual({
      action: 'close',
      comment: null,
    })
  })

  test('refuses and names unlanded work', () => {
    expect(
      decideTaskClose({
        available: true,
        unlanded: [{ branch: 'DEV-1027-worker', reason: 'unlanded; 2 commits not on trunk' }],
      }),
    ).toEqual({
      action: 'refuse',
      reason:
        'refusing to close a task with unlanded branch work:\n' +
        '  DEV-1027-worker: unlanded; 2 commits not on trunk\n' +
        'Land each branch, delete it, or pass --abandon "<reason>" to close and record why the work was abandoned.',
      unlanded: {
        facts:
          'refusing to close a task with unlanded branch work:\n' +
          '  DEV-1027-worker: unlanded; 2 commits not on trunk',
        remedy:
          'Land each branch, delete it, or pass --abandon "<reason>" to close and record why the work was abandoned.',
      },
    })
  })

  test('force closes unlanded work and records its reason', () => {
    expect(
      decideTaskClose(
        {
          available: true,
          unlanded: [{ branch: 'DEV-1027-worker', reason: 'unlanded' }],
        },
        'prototype deliberately abandoned',
      ),
    ).toEqual({ action: 'close', comment: 'prototype deliberately abandoned' })
  })

  test('refuses when classification is unavailable', () => {
    expect(decideTaskClose({ available: false, reason: 'git failed' })).toEqual({
      action: 'refuse',
      reason:
        'branch classification unavailable: git failed; restore orchestrator and git access, then retry',
    })
  })
})

describe('task close claim release', () => {
  test('closes a task by abandoning its foreign open cursor before releasing claims', async () => {
    let cursorState = 'running'
    let taskState = 'active'
    const openCursor = {
      id: 41,
      record_id: '01a1ed7c-1111-7111-8111-111111111111',
      project: PLATFORM_NAME,
      workflow_slug: 'ship-task',
      workflow_key: 'DEV-1',
      session_id: 'foreign-session',
      live_runs: [],
    } satisfies OpenTaskWorkflowCursor
    const abandoned: unknown[] = []
    await closeThenPrune('DEV-1', {}, true, undefined, UNATTRIBUTED, 'production', {
      project: () => PLATFORM_NAME,
      callingSession: 'calling-session',
      listCursors: async () => [openCursor],
      abandonCursor: async (_cursor, reason, owner) => {
        expect(reason).toBe('task DEV-1 closed (done)')
        expect(owner).toBe('foreign-session')
        cursorState = 'abandoned'
      },
      close: async () => {
        expect(cursorState).toBe('running')
        taskState = 'done'
        return closedTask
      },
      releaseClaims: async () => {
        expect(cursorState).toBe('abandoned')
        return { released: 1 }
      },
      cursorAbandoned: (result) => abandoned.push(result),
    })

    expect(taskState).toBe('done')
    expect(cursorState).toBe('abandoned')
    expect(abandoned).toEqual([
      { number: 41, workflow: 'ship-task', reason: 'task DEV-1 closed (done)' },
    ])
  })

  test('a refused close leaves every cursor untouched', async () => {
    let abandonCalls = 0
    await expect(
      closeThenPrune('DEV-1', {}, true, undefined, UNATTRIBUTED, 'production', {
        project: () => PLATFORM_NAME,
        listCursors: async () => [
          {
            id: 41,
            record_id: '01a1ed7c-1111-7111-8111-111111111111',
            project: PLATFORM_NAME,
            workflow_slug: 'ship-task',
            workflow_key: 'DEV-1',
            session_id: 'foreign-session',
            live_runs: [],
          },
        ],
        abandonCursor: async () => {
          abandonCalls += 1
        },
        close: async () => {
          throw new Error('refusing to close a task with unlanded branch work')
        },
      }),
    ).rejects.toThrow('unlanded branch work')
    expect(abandonCalls).toBe(0)
  })

  test('a cursor live run refuses before the task close or any abandonment', async () => {
    let closeCalls = 0
    let abandonCalls = 0
    await expect(
      closeThenPrune('DEV-1', {}, true, undefined, UNATTRIBUTED, 'production', {
        project: () => PLATFORM_NAME,
        listCursors: async () => [
          {
            id: 41,
            record_id: '01a1ed7c-1111-7111-8111-111111111111',
            project: PLATFORM_NAME,
            workflow_slug: 'ship-task',
            workflow_key: 'DEV-1',
            session_id: 'foreign-session',
            live_runs: [
              {
                number: 37503,
                record_id: '01a1ed7c-2222-7222-8222-222222222222',
              },
            ],
          },
        ],
        abandonCursor: async () => {
          abandonCalls += 1
        },
        close: async () => {
          closeCalls += 1
          return closedTask
        },
      }),
    ).rejects.toThrow(`clear it with: ${PLATFORM_SLUG} run stop 37503`)
    expect(closeCalls).toBe(0)
    expect(abandonCalls).toBe(0)
  })

  test('releases claims after close even when branches are kept', async () => {
    let released = ''
    await closeThenPrune('DEV-1', {}, true, undefined, UNATTRIBUTED, 'production', {
      ...cursorDependencies,
      close: async () => closedTask,
      releaseClaims: async (project, key) => {
        released = `${project}:${key}`
        return { released: 2 }
      },
    })
    expect(released).toBe(`${PLATFORM_NAME}:DEV-1`)
  })

  test('reports a remaining claim release refusal and its remedy', async () => {
    const printed: string[] = []
    const operation = closeThenPrune('DEV-1', {}, true, undefined, UNATTRIBUTED, 'production', {
      project: () => PLATFORM_NAME,
      listCursors: async () => [
        {
          id: 51,
          record_id: '01a1ed7c-4444-7444-8444-444444444444',
          project: PLATFORM_NAME,
          workflow_slug: 'ship-task',
          workflow_key: 'DEV-1',
          session_id: 'foreign-session',
          live_runs: [],
        },
      ],
      abandonCursor: async () => {},
      cursorAbandoned: (cursor) => printed.push(`cursor ${cursor.number} abandoned`),
      close: async () => closedTask,
      releaseClaims: async () => {
        throw new Error(
          `claim remains; abandon its cursor, then retry: ${PLATFORM_SLUG} board claim release-task DEV-1`,
        )
      },
    })
    const error = await operation.catch((cause) => cause)
    expect(error).toBeInstanceOf(TaskClosedWithResidueError)
    expect(error.task).toBe(closedTask)
    expect(error.residue).toBe('claim-release')
    expect(error.message).toBe(
      `task DEV-1 is closed; claim release did not finish: claim remains; abandon its cursor, then retry: ${PLATFORM_SLUG} board claim release-task DEV-1\n` +
        `clear it with: ${PLATFORM_SLUG} board claim release-task DEV-1 --project ${PLATFORM_NAME}`,
    )
    expect(printed).toEqual(['cursor 51 abandoned'])
  })

  test('reports cursor abandonment failure as residue after the task closes', async () => {
    let releaseCalls = 0
    const operation = closeThenPrune('DEV-1', {}, true, undefined, UNATTRIBUTED, 'production', {
      project: () => PLATFORM_NAME,
      listCursors: async () => [
        {
          id: 52,
          record_id: '01a1ed7c-5555-7555-8555-555555555555',
          project: PLATFORM_NAME,
          workflow_slug: 'ship-task',
          workflow_key: 'DEV-1',
          session_id: 'foreign-session',
          live_runs: [],
        },
      ],
      close: async () => closedTask,
      abandonCursor: async () => {
        throw new Error('cursor store unavailable; retry workflow abandon')
      },
      releaseClaims: async () => {
        releaseCalls += 1
        return { released: 1 }
      },
    })

    const error = await operation.catch((cause) => cause)
    expect(error).toBeInstanceOf(TaskClosedWithResidueError)
    expect(error.task).toBe(closedTask)
    expect(error.residue).toBe('cursor-abandon')
    expect(error.message).toBe(
      `task DEV-1 is closed; workflow cursor cleanup did not finish: cursor store unavailable; retry workflow abandon\n` +
        `clear it with: ${PLATFORM_SLUG} workflow abandon ship-task --cursor 52 --project ${PLATFORM_NAME} --owner-session foreign-session --reason "task DEV-1 closed (done)"`,
    )
    expect(releaseCalls).toBe(0)
  })

  test('throws branch prune residue with the closed row and retry command', async () => {
    const operation = closeThenPrune('DEV-1', {}, false, undefined, UNATTRIBUTED, 'production', {
      ...cursorDependencies,
      close: async () => closedTask,
      releaseClaims: async () => ({ released: 1 }),
      prune: async () => {
        throw new Error('git worktree is busy')
      },
    })
    const error = await operation.catch((cause) => cause)
    expect(error).toBeInstanceOf(TaskClosedWithResidueError)
    expect(error.task).toBe(closedTask)
    expect(error.residue).toBe('branch-prune')
    expect(error.message).toBe(
      `task DEV-1 is closed; branch prune did not finish: git worktree is busy\n` +
        `clear it with: ${PLATFORM_SLUG} tree branch prune --project ${PLATFORM_NAME} --key DEV-1`,
    )
  })
})
