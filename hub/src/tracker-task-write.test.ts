import { beforeEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import { observeTrackerTask, type TrackerTask } from './ingest/trackers.ts'
import type { RegisteredProject } from './projects.ts'
import { closeTask, showTask } from './task.ts'
import { UNATTRIBUTED } from './task-attribution.ts'
import { TaskClosedWithResidueError } from './task-closed-residue.ts'
import type { OpenTaskWorkflowCursor } from './task-workflow-cursors.ts'
import {
  closeTaskThroughTracker,
  commentTaskThroughTracker,
  setTaskThroughTracker,
} from './tracker-task-write.ts'

const taskId = '01990000-0000-7000-8000-000000001659'
const project = {
  record_id: '01990000-0000-7000-8000-000000001658',
  name: 'adanim',
  path: '/fixture/adanim',
  stack: 'node',
  canon: true,
  repository: true,
  settings: {
    envPrefix: 'ADANIM',
    tracker: {
      protocol: 'array-mcp',
      states: {
        backlog: 'backlog',
        todo: 'open',
        in_progress: 'active',
        done: 'done',
        cancelled: 'dropped',
      },
    },
  },
} satisfies RegisteredProject

const branchClassification = {
  project: 'adanim',
  key: 'ADN-1659',
  dryRun: true,
  deleted: [],
  kept: [],
  operator: [],
  wouldDelete: [],
  errors: [],
}

function seedTrackerTask(): void {
  writeTransaction((conn) => {
    const insert = conn.query(
      `INSERT INTO task
         (record_id,external_id,key,project,parent_key,parent_record_id,title,status,status_category,source,first_seen,last_seen)
         VALUES (?,?,?,?,?,?,?,'todo','open','mcp',?,?)`,
    )
    const parentRecordId = '01990000-0000-7000-8000-000000001661'
    insert.run(
      parentRecordId,
      'tracker-parent',
      'ADN-1600',
      'adanim',
      null,
      null,
      'Parent task',
      '2026-10-23T12:00:00.000Z',
      '2026-10-23T12:00:00.000Z',
    )
    insert.run(
      '01990000-0000-7000-8000-000000001660',
      taskId,
      'ADN-1659',
      'adanim',
      'ADN-1600',
      parentRecordId,
      'Route tracker writes',
      '2026-10-23T12:00:00.000Z',
      '2026-10-23T12:00:00.000Z',
    )
  })
}

function dependencies(callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  return {
    registeredProjects: () => [project],
    readCredentials: async () => ({ url: 'https://tracker.invalid/mcp', token: 'fixture' }),
    connect: async () => ({ callTool, close: async () => {} }),
    classify: async () => branchClassification,
    listCursors: async () => [],
  }
}

describe('array-mcp task writes', () => {
  beforeEach(() => {
    resetFixtureStore()
    seedTrackerTask()
  })

  test('set routes a raw registered status through task_update before updating the cache', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    let observedParent: TrackerTask['parentKey'] = null
    const fixture = {
      ...dependencies(async (name, args) => {
        calls.push({ name, args })
        return { id: taskId, status: 'in_progress' }
      }),
      observe: (...args: Parameters<typeof observeTrackerTask>) => {
        const [task] = args
        observedParent = task.parentKey
        return observeTrackerTask(...args)
      },
    }
    const row = await setTaskThroughTracker(
      'ADN-1659',
      {},
      { status: 'in_progress' },
      UNATTRIBUTED,
      { confirm: 'operator-confirmation' },
      fixture,
    )

    expect(calls).toEqual([
      {
        name: 'task_update',
        args: { id: taskId, status: 'in_progress', confirm: 'operator-confirmation' },
      },
    ])
    expect(row).toMatchObject({ status: 'in_progress', status_category: 'active' })
    expect(observedParent).toBeUndefined()
    expect(
      db()
        .query<{ parent_record_id: string }, []>(
          `SELECT parent_record_id FROM task WHERE key='ADN-1659'`,
        )
        .get()?.parent_record_id,
    ).toBe('01990000-0000-7000-8000-000000001661')
  })

  test('set maps a hub status to its single registered tracker state', async () => {
    const calls: Record<string, unknown>[] = []
    const row = await setTaskThroughTracker(
      'ADN-1659',
      {},
      { status: 'active' },
      UNATTRIBUTED,
      { confirm: 'production' },
      dependencies(async (_name, args) => {
        calls.push(args)
        return {}
      }),
    )

    expect(calls).toEqual([{ id: taskId, status: 'in_progress', confirm: 'production' }])
    expect(row).toMatchObject({ status: 'in_progress', status_category: 'active' })
  })

  test('set uses the selected raw done state (mutation: ignore writeStates in array writes)', async () => {
    const selected = {
      ...project,
      settings: {
        ...project.settings,
        tracker: {
          ...project.settings.tracker,
          states: {
            backlog: 'backlog' as const,
            todo: 'open' as const,
            in_progress: 'active' as const,
            completed: 'done' as const,
            complete: 'done' as const,
            cancelled: 'dropped' as const,
          },
          writeStates: { done: 'complete' },
        },
      },
    }
    const calls: Record<string, unknown>[] = []

    await setTaskThroughTracker(
      'ADN-1659',
      {},
      { status: 'done' },
      UNATTRIBUTED,
      { confirm: 'production' },
      {
        ...dependencies(async (_name, args) => {
          calls.push(args)
          return {}
        }),
        registeredProjects: () => [selected],
      },
    )

    expect(calls).toEqual([{ id: taskId, status: 'complete', confirm: 'production' }])
  })

  test('set refuses a hub status with no tracker state and names valid states', async () => {
    await expect(
      setTaskThroughTracker(
        'ADN-1659',
        {},
        { status: 'review' },
        UNATTRIBUTED,
        { confirm: 'production' },
        dependencies(async () => {
          throw new Error('tracker must not be called')
        }),
      ),
    ).rejects.toThrow(
      'status review does not resolve to exactly one state for project adanim; valid states: backlog, todo, in_progress, done, cancelled',
    )
  })

  test('close writes the mapped done state through task_update', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const row = await closeTaskThroughTracker(
      'ADN-1659',
      {},
      UNATTRIBUTED,
      { confirm: 'production' },
      dependencies(async (name, args) => {
        calls.push({ name, args })
        return { id: taskId, status: 'done' }
      }),
    )

    expect(calls).toEqual([
      {
        name: 'task_update',
        args: { id: taskId, status: 'done', confirm: 'production' },
      },
    ])
    expect(row.status_category).toBe('done')
    expect(row.closed_at).toBeTruthy()
  })

  test('a tracker failure leaves the cached task open', async () => {
    await expect(
      closeTaskThroughTracker(
        'ADN-1659',
        {},
        UNATTRIBUTED,
        { confirm: 'production' },
        dependencies(async () => {
          throw new Error('tracker refused the transition')
        }),
      ),
    ).rejects.toThrow('tracker refused the transition')

    expect(showTask('ADN-1659').task).toMatchObject({
      status: 'todo',
      status_category: 'open',
    })
    expect(db().query(`SELECT closed_at FROM task WHERE key='ADN-1659'`).get()).toEqual({
      closed_at: null,
    })
  })

  test('a failed set transition leaves the cached status unchanged', async () => {
    await expect(
      setTaskThroughTracker(
        'ADN-1659',
        {},
        { status: 'in_progress' },
        UNATTRIBUTED,
        { confirm: 'production' },
        dependencies(async () => {
          throw new Error('tracker refused the status')
        }),
      ),
    ).rejects.toThrow('tracker refused the status')

    expect(showTask('ADN-1659').task).toMatchObject({
      status: 'todo',
      status_category: 'open',
    })
  })

  test('a reply without status observes the requested status', async () => {
    const row = await setTaskThroughTracker(
      'ADN-1659',
      {},
      { status: 'cancelled' },
      UNATTRIBUTED,
      { confirm: 'production' },
      dependencies(async () => ({ id: taskId })),
    )

    expect(row).toMatchObject({ status: 'cancelled', status_category: 'dropped' })
  })

  test('task set to a dropped category abandons its open cursor after the tracker write', async () => {
    let cursorState = 'running'
    const calls: string[] = []
    const openCursor = {
      id: 62,
      record_id: '01a1ed7c-3333-7333-8333-333333333333',
      project: 'adanim',
      workflow_slug: 'ship-task',
      workflow_key: 'ADN-1659',
      session_id: 'dead-session',
      live_runs: [],
    } satisfies OpenTaskWorkflowCursor

    const row = await setTaskThroughTracker(
      'ADN-1659',
      {},
      { status: 'cancelled' },
      UNATTRIBUTED,
      { confirm: 'production' },
      {
        ...dependencies(async () => {
          calls.push(`write:${cursorState}`)
          return { id: taskId, status: 'cancelled' }
        }),
        callingSession: 'calling-session',
        listCursors: async () => [openCursor],
        abandonCursor: async (_cursor, reason, owner) => {
          expect(reason).toBe('task ADN-1659 closed (dropped)')
          expect(owner).toBe('dead-session')
          cursorState = 'abandoned'
        },
      },
    )

    expect(row.status_category).toBe('dropped')
    expect(cursorState).toBe('abandoned')
    expect(calls).toEqual(['write:running'])
  })

  test('a local task set to done writes before abandoning its foreign cursor', async () => {
    writeTransaction((conn) =>
      conn.query(`UPDATE task SET source='local' WHERE key='ADN-1659'`).run(),
    )
    let cursorState = 'running'
    const calls: string[] = []
    const current = showTask('ADN-1659').task

    const row = await setTaskThroughTracker(
      'ADN-1659',
      {},
      { status: 'done' },
      UNATTRIBUTED,
      { confirm: 'production' },
      {
        callingSession: 'calling-session',
        listCursors: async () => [
          {
            id: 63,
            record_id: '01a1ed7c-3333-7333-8333-333333333334',
            project: 'adanim',
            workflow_slug: 'ship-task',
            workflow_key: 'ADN-1659',
            session_id: 'foreign-session',
            live_runs: [],
          },
        ],
        localSet: async () => {
          calls.push(`write:${cursorState}`)
          return { ...current, status: 'done', status_category: 'done' }
        },
        abandonCursor: async (_cursor, reason, owner) => {
          expect(reason).toBe('task ADN-1659 closed (done)')
          expect(owner).toBe('foreign-session')
          cursorState = 'abandoned'
        },
      },
    )

    expect(row.status_category).toBe('done')
    expect(calls).toEqual(['write:running'])
    expect(cursorState).toBe('abandoned')
  })

  test('a cursor abandonment failure carries the task row written by task set', async () => {
    writeTransaction((conn) =>
      conn.query(`UPDATE task SET source='local' WHERE key='ADN-1659'`).run(),
    )
    const current = showTask('ADN-1659').task
    const written = { ...current, status: 'done', status_category: 'done' } as const

    try {
      await setTaskThroughTracker(
        'ADN-1659',
        {},
        { status: 'done' },
        UNATTRIBUTED,
        { confirm: 'production' },
        {
          callingSession: 'calling-session',
          listCursors: async () => [
            {
              id: 64,
              record_id: '01a1ed7c-3333-7333-8333-333333333335',
              project: 'adanim',
              workflow_slug: 'ship-task',
              workflow_key: 'ADN-1659',
              session_id: 'foreign-session',
              live_runs: [],
            },
          ],
          localSet: async () => written,
          abandonCursor: async () => {
            throw new Error('cursor store unavailable; retry workflow abandon')
          },
        },
      )
      throw new Error('expected task cursor residue')
    } catch (error) {
      expect(error).toBeInstanceOf(TaskClosedWithResidueError)
      expect((error as TaskClosedWithResidueError).task).toBe(written)
      expect((error as TaskClosedWithResidueError).residue).toBe('cursor-abandon')
      expect((error as Error).message).toBe(
        `task ADN-1659 is closed; workflow cursor cleanup did not finish: cursor store unavailable; retry workflow abandon\n` +
          `clear it with: ${PLATFORM_SLUG} workflow abandon ship-task --cursor 64 --project adanim --owner-session foreign-session --reason "task ADN-1659 closed (done)"`,
      )
    }
  })

  test('a differing reply status is observed before the write refuses', async () => {
    await expect(
      setTaskThroughTracker(
        'ADN-1659',
        {},
        { status: 'in_progress' },
        UNATTRIBUTED,
        { confirm: 'production' },
        dependencies(async () => ({ id: taskId, status: 'cancelled' })),
      ),
    ).rejects.toThrow(
      'tracker answered with status cancelled after in_progress was requested for task ADN-1659',
    )
    expect(showTask('ADN-1659').task).toMatchObject({
      status: 'cancelled',
      status_category: 'dropped',
    })
  })

  for (const protocol of ['workspace-mcp', 'cursor-mcp'] as const) {
    test(`${protocol} observes a confirming mismatch before refusing`, async () => {
      const registered: RegisteredProject = {
        ...project,
        settings: {
          ...project.settings,
          tracker:
            protocol === 'workspace-mcp'
              ? {
                  protocol,
                  team: 'TEAM',
                  states: { Open: 'open' as const, 'In Progress': 'active' as const },
                  writeStates: { active: 'In Progress' },
                }
              : {
                  protocol,
                  projectId: '019d9699-a223-729f-a032-50de9fdf4303',
                  states: {
                    todo: 'open' as const,
                    in_progress: 'active' as const,
                    cancelled: 'dropped' as const,
                  },
                },
        },
      }
      const calls: { name: string; args: Record<string, unknown> }[] = []

      await expect(
        setTaskThroughTracker(
          'ADN-1659',
          {},
          { status: 'active' },
          UNATTRIBUTED,
          { confirm: 'production' },
          {
            ...dependencies(async (name, args) => {
              calls.push({ name, args })
              if (protocol === 'workspace-mcp') {
                return name === 'update-task-tool'
                  ? { id: taskId }
                  : { short_id: 'ADN-1659', status: 'Open', status_category: 'open' }
              }
              return { success: true, data: { status: 'cancelled' } }
            }),
            registeredProjects: () => [registered],
          },
        ),
      ).rejects.toThrow(
        protocol === 'workspace-mcp'
          ? 'returned category open after category active was requested'
          : 'returned cancelled after in_progress was requested',
      )
      expect(showTask('ADN-1659').task).toMatchObject(
        protocol === 'workspace-mcp'
          ? { status: 'Open', status_category: 'open' }
          : { status: 'cancelled', status_category: 'dropped' },
      )
      expect(calls).toEqual(
        protocol === 'workspace-mcp'
          ? [
              { name: 'update-task-tool', args: { id: 'ADN-1659', status: 'In Progress' } },
              { name: 'get-task-tool', args: { id: 'ADN-1659' } },
            ]
          : [{ name: 'task.update', args: { id: taskId, status: 'in_progress' } }],
      )
    })
  }

  for (const { label, reply } of [
    { label: 'an unsuccessful cursor reply', reply: { success: false, error: 'x' } },
    { label: 'an empty cursor reply', reply: {} },
    { label: 'a cursor reply without data status', reply: { success: true, data: {} } },
  ] as const) {
    test(`${label} records no observation`, async () => {
      const registered: RegisteredProject = {
        ...project,
        settings: {
          ...project.settings,
          tracker: {
            protocol: 'cursor-mcp',
            projectId: '019d9699-a223-729f-a032-50de9fdf4303',
            states: { todo: 'open', in_progress: 'active' },
          },
        },
      }

      await expect(
        setTaskThroughTracker(
          'ADN-1659',
          {},
          { status: 'active' },
          UNATTRIBUTED,
          { confirm: 'production' },
          {
            ...dependencies(async () => reply),
            registeredProjects: () => [registered],
          },
        ),
      ).rejects.toThrow('cursor-mcp status confirmation for task ADN-1659 returned')
      expect(showTask('ADN-1659').task).toMatchObject({
        status: 'todo',
        status_category: 'open',
      })
      expect(db().query('SELECT count(*) count FROM task_status_event').get()).toEqual({ count: 0 })
    })
  }

  test('a blank workspace confirmation records no observation', async () => {
    const registered: RegisteredProject = {
      ...project,
      settings: {
        ...project.settings,
        tracker: {
          protocol: 'workspace-mcp',
          team: 'TEAM',
          states: { Open: 'open', 'In Progress': 'active' },
          writeStates: { active: 'In Progress' },
        },
      },
    }

    await expect(
      setTaskThroughTracker(
        'ADN-1659',
        {},
        { status: 'active' },
        UNATTRIBUTED,
        { confirm: 'production' },
        {
          ...dependencies(async (name) =>
            name === 'update-task-tool'
              ? { id: taskId }
              : { short_id: 'ADN-1659', status: '', status_category: 'open' },
          ),
          registeredProjects: () => [registered],
        },
      ),
    ).rejects.toThrow('workspace-mcp status confirmation for task ADN-1659 returned no status')
    expect(showTask('ADN-1659').task).toMatchObject({
      status: 'todo',
      status_category: 'open',
    })
    expect(db().query('SELECT count(*) count FROM task_status_event').get()).toEqual({ count: 0 })
  })

  test('the local close service refuses a tracker row', async () => {
    await expect(closeTask('ADN-1659', {}, UNATTRIBUTED)).rejects.toThrow(
      'task ADN-1659 is not local',
    )
  })

  test('an external set refuses mixed fields and names the separate-call remedy', async () => {
    await expect(
      setTaskThroughTracker(
        'ADN-1659',
        {},
        { status: 'in_progress', body: 'new body' },
        UNATTRIBUTED,
        { confirm: 'production' },
        dependencies(async () => {
          throw new Error('tracker must not be called')
        }),
      ),
    ).rejects.toThrow('external tracker can only set status; set body in a separate call')
  })

  test('a workspace status without a write-state selection refuses with its remedy', async () => {
    const unsupported = {
      ...project,
      settings: {
        ...project.settings,
        tracker: { ...project.settings.tracker, protocol: 'workspace-mcp' as const },
      },
    }
    await expect(
      setTaskThroughTracker(
        'ADN-1659',
        {},
        { status: 'active' },
        UNATTRIBUTED,
        { confirm: 'production' },
        { registeredProjects: () => [unsupported] },
      ),
    ).rejects.toThrow(
      `${PLATFORM_SLUG} project set adanim --settings '{"tracker":{"writeStates":{"active":"<active-state>"}}}'`,
    )
  })

  test('an external done transition names a remedy that does not suggest unsupported abandon', async () => {
    await expect(
      closeTaskThroughTracker(
        'ADN-1659',
        {},
        UNATTRIBUTED,
        { confirm: 'production' },
        {
          ...dependencies(async () => {
            throw new Error('tracker must not be called')
          }),
          classify: async () => ({
            ...branchClassification,
            operator: [
              {
                branch: 'ADN-1659-work',
                state: 'unlanded' as const,
                commitsNotOnTrunk: 1,
                command: 'git branch -D ADN-1659-work',
              },
            ],
          }),
        },
      ),
    ).rejects.toThrow('tracker has no comment writer, so --abandon cannot record its reason')
  })

  test('comment refuses with the workflow cursor remedy', async () => {
    await expect(
      commentTaskThroughTracker('ADN-1659', {}, 'acceptance evidence', UNATTRIBUTED, {
        registeredProjects: () => [project],
      }),
    ).rejects.toThrow(
      `array-mcp tracker exposes no comment action; record the text on the workflow cursor with: ${PLATFORM_SLUG} workflow attach --cursor <cursor> --file <path>`,
    )
  })
})
