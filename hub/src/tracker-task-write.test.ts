import { beforeEach, describe, expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../shared/brand.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import type { RegisteredProject } from './projects.ts'
import { closeTask, showTask } from './task.ts'
import { UNATTRIBUTED } from './task-attribution.ts'
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
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO task
         (record_id,external_id,key,project,title,status,status_category,source,first_seen,last_seen)
         VALUES (?,?,?,?,?,'todo','open','mcp',?,?)`,
      )
      .run(
        '01990000-0000-7000-8000-000000001660',
        taskId,
        'ADN-1659',
        'adanim',
        'Route tracker writes',
        '2026-10-23T12:00:00.000Z',
        '2026-10-23T12:00:00.000Z',
      ),
  )
}

function dependencies(callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  return {
    registeredProjects: () => [project],
    readCredentials: async () => ({ url: 'https://tracker.invalid/mcp', token: 'fixture' }),
    connect: async () => ({ callTool, close: async () => {} }),
    classify: async () => branchClassification,
  }
}

describe('array-mcp task writes', () => {
  beforeEach(() => {
    resetFixtureStore()
    seedTrackerTask()
  })

  test('set routes a raw registered status through task_update before updating the cache', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const row = await setTaskThroughTracker(
      'ADN-1659',
      {},
      { status: 'in_progress' },
      UNATTRIBUTED,
      { confirm: 'operator-confirmation' },
      dependencies(async (name, args) => {
        calls.push({ name, args })
        return { id: taskId, status: 'in_progress' }
      }),
    )

    expect(calls).toEqual([
      {
        name: 'task_update',
        args: { id: taskId, status: 'in_progress', confirm: 'operator-confirmation' },
      },
    ])
    expect(row).toMatchObject({ status: 'in_progress', status_category: 'active' })
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

  test('an unsupported tracker protocol refuses before interpreting its vocabulary', async () => {
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
        { status: 'not-in-vocabulary' },
        UNATTRIBUTED,
        { confirm: 'production' },
        { registeredProjects: () => [unsupported] },
      ),
    ).rejects.toThrow('tracker protocol workspace-mcp has no status writer')
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
