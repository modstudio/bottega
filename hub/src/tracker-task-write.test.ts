import { beforeEach, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { db, writeTransaction } from './db.ts'
import type { RegisteredProject } from './projects.ts'
import { showTask } from './task.ts'
import { UNATTRIBUTED } from './task-attribution.ts'
import {
  closeTaskThroughTracker,
  commentTaskThroughTracker,
  setTaskStatusThroughTracker,
} from './tracker-task-write.ts'

const taskId = '01990000-0000-7000-8000-000000001659'
const project = {
  name: 'adanim',
  settings: {
    envPrefix: 'ADANIM',
    tracker: {
      protocol: 'array-mcp',
      states: { todo: 'open', in_progress: 'active', done: 'done' },
    },
  },
} as RegisteredProject

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
    const row = await setTaskStatusThroughTracker(
      'ADN-1659',
      {},
      'in_progress',
      UNATTRIBUTED,
      {},
      dependencies(async (name, args) => {
        calls.push({ name, args })
        return { id: taskId, status: 'in_progress' }
      }),
    )

    expect(calls).toEqual([
      {
        name: 'task_update',
        args: { id: taskId, status: 'in_progress', confirm: 'production' },
      },
    ])
    expect(row).toMatchObject({ status: 'in_progress', status_category: 'active' })
  })

  test('close writes the mapped done state through task_update', async () => {
    const calls: { name: string; args: Record<string, unknown> }[] = []
    const row = await closeTaskThroughTracker(
      'ADN-1659',
      {},
      UNATTRIBUTED,
      {},
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
        {},
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

  test('comment refuses with the workflow cursor remedy', async () => {
    await expect(
      commentTaskThroughTracker('ADN-1659', {}, 'acceptance evidence', UNATTRIBUTED, {
        registeredProjects: () => [project],
      }),
    ).rejects.toThrow(
      'array-mcp tracker exposes no comment action; record the text on the workflow cursor with: bottega workflow attach --cursor <cursor> --file <path>',
    )
  })
})
