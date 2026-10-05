import { beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { TrackerSource, TrackerTask } from '../../shared/trackers.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { acquireLease, leaseHolder, releaseLease, withLease } from './collect.ts'
import { db } from './db.ts'
import type { CollectorMirrorPass } from './ingest/collector-mirror.ts'
import { observeTrackerTask, writeTrackerCache } from './ingest/trackers.ts'
import type { RegisteredProject } from './projects.ts'
import { showTask } from './task.ts'
import { refreshTrackerTask } from './tracker-task-cli.ts'

const project = {
  name: 'fixture',
  path: '/fixture',
  repository: true,
  settings: {
    keyPrefixes: ['FIX'],
    tracker: { protocol: 'workspace-mcp', envPrefix: 'FIXTURE' },
  },
} as RegisteredProject

const task: TrackerTask = {
  externalId: 'task-1',
  key: 'FIX-1',
  project: 'fixture',
  title: 'Fresh task',
  status: 'In Progress',
  category: 'active',
  updatedAt: null,
  assignee: null,
}

const source = (lookup: TrackerSource['lookup']): TrackerSource => ({
  project: 'fixture',
  env: 'FIXTURE',
  fetch: async () => [],
  lookup,
})

const shown = {
  task: { key: 'FIX-1' },
  comments: [],
  documents: [],
} as unknown as ReturnType<typeof import('./task.ts')['showTask']>

const noOpMirror = async (): Promise<CollectorMirrorPass> => ({
  mirrorTasks: async () => {},
  mirrorStatusEvents: async () => {},
  reportSkipped: () => {},
})

const dependencies = (lookup: TrackerSource['lookup']) => ({
  registeredProjects: () => [project],
  sourceFor: () => source(lookup),
  readCredentials: async () => ({ url: 'https://tracker.invalid/mcp', token: 'secret-value' }),
  connect: async () => ({
    callTool: async () => ({}),
    close: async () => {},
  }),
  lease: async <T>(_holder: string, fn: (guard: { assertHeld(): void }) => Promise<T>) => ({
    ran: true as const,
    value: await fn({ assertHeld() {} }),
  }),
  createMirror: noOpMirror,
  readBack: () => shown,
})

describe('fresh tracker task read', () => {
  beforeEach(resetFixtureStore)

  test('upserts a task returned by the registered source lookup', async () => {
    const observed: TrackerTask[] = []
    const result = await refreshTrackerTask('FIX-1', undefined, {
      ...dependencies(async () => task),
      observe: (value) => {
        observed.push(value)
        return {
          at: '2026-10-05T00:00:00.000Z',
          taskRecordId: null,
          taskKey: value.key,
          event: null,
        }
      },
    })
    expect(observed).toEqual([task])
    expect(result).toEqual({ trackerRead: true, commentsVerifiable: false, shown })
  })

  test('refuses when the source lookup does not find the task', async () => {
    await expect(
      refreshTrackerTask(
        'FIX-404',
        undefined,
        dependencies(async () => null),
      ),
    ).rejects.toThrow(
      "task FIX-404 was not found in project fixture's tracker by its single-task lookup",
    )
  })

  test('refuses when the tracker cannot be reached', async () => {
    await expect(
      refreshTrackerTask('FIX-1', undefined, {
        ...dependencies(async () => task),
        connect: async () => {
          throw new Error('tracker unavailable')
        },
      }),
    ).rejects.toThrow('tracker unavailable')
  })

  test('redacts a tracker close failure', async () => {
    await expect(
      refreshTrackerTask('FIX-1', undefined, {
        ...dependencies(async () => task),
        connect: async () => ({
          callTool: async () => ({}),
          close: async () => {
            throw new Error('close failed with Authorization: Bearer secret-value')
          },
        }),
      }),
    ).rejects.toThrow('[redacted]')
  })

  test.each([
    ['an HTTP body', 'HTTP 500: {"token":"secret-value","body":"private"}'],
    ['a tool error', 'task_get returned an error: {"authorization":"Bearer secret-value"}'],
    ['JSON-RPC error data', 'task_get: {"code":-1,"data":{"secret":"secret-value"}}'],
  ])('redacts the token and %s from tracker failures', async (_kind, message) => {
    await expect(
      refreshTrackerTask('FIX-1', undefined, {
        ...dependencies(async () => {
          throw new Error(message)
        }),
        readCredentials: async () => ({
          url: 'https://tracker.invalid/mcp',
          token: 'secret-value',
        }),
      }),
    ).rejects.toThrow('[redacted]')
    try {
      await refreshTrackerTask('FIX-1', undefined, {
        ...dependencies(async () => {
          throw new Error(message)
        }),
      })
    } catch (error) {
      expect(String(error)).not.toContain('secret-value')
      expect(String(error)).not.toContain('private')
      expect(String(error)).not.toContain('authorization')
      expect(String(error)).not.toContain('data')
    }
  })

  test('a held collect lease refuses the fresh read without starting its lookup', async () => {
    expect(acquireLease('collect:fixture')).toBeTrue()
    let lookedUp = false
    try {
      await expect(
        refreshTrackerTask('FIX-1', undefined, {
          ...dependencies(async () => {
            lookedUp = true
            return task
          }),
          lease: withLease,
          leaseWaitMs: 0,
        }),
      ).rejects.toThrow(
        'collect:fixture holds the collect lease; fresh task read was not performed',
      )
      expect(lookedUp).toBeFalse()
    } finally {
      releaseLease('collect:fixture')
    }
  })

  test("a collect cannot overlap a fresh read's lease", async () => {
    let releaseLookup!: () => void
    const lookupCanFinish = new Promise<void>((resolve) => {
      releaseLookup = resolve
    })
    let lookupStarted!: () => void
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve
    })
    const fresh = refreshTrackerTask('FIX-1', undefined, {
      ...dependencies(async () => {
        lookupStarted()
        await lookupCanFinish
        return task
      }),
      lease: withLease,
      observe: (value) => ({
        at: '2026-10-05T00:00:00.000Z',
        taskRecordId: null,
        taskKey: value.key,
        event: null,
      }),
    })
    await started

    const collect = await withLease('collect:fixture', async () => {}, 0)
    expect(collect.ran).toBeFalse()
    if (!collect.ran) expect(collect.heldBy).toStartWith('fresh-task:FIX-1:')
    releaseLookup()
    await fresh
  })

  test('a fresh read whose lease is taken refuses without writing afterward', async () => {
    let releaseLookup!: () => void
    const lookupCanFinish = new Promise<void>((resolve) => (releaseLookup = resolve))
    let lookupStarted!: () => void
    const started = new Promise<void>((resolve) => (lookupStarted = resolve))
    const fresh = refreshTrackerTask('FIX-1', undefined, {
      ...dependencies(async () => {
        lookupStarted()
        await lookupCanFinish
        return task
      }),
      lease: withLease,
      readBack: showTask,
    })
    await started
    const freshHolder = leaseHolder()!
    releaseLease(freshHolder)
    expect(acquireLease('takeover')).toBeTrue()
    releaseLookup()
    await expect(fresh).rejects.toThrow(
      'takeover holds the collect lease; fresh task read was not performed',
    )
    expect(db().query(`SELECT 1 FROM task WHERE key='FIX-1'`).get()).toBeNull()
    releaseLease('takeover')
  })

  test('records one first-observed category change and the following collect records none', async () => {
    expect(observeTrackerTask({ ...task, status: 'Open', category: 'open' }).event).toBeNull()

    await refreshTrackerTask('FIX-1', undefined, {
      ...dependencies(async () => task),
      lease: withLease,
      observe: observeTrackerTask,
      readBack: showTask,
    })
    expect(
      db().query<{ count: number }, []>('SELECT count(*) count FROM task_status_event').get()
        ?.count,
    ).toBe(1)
    expect(
      writeTrackerCache([task], '2026-10-05T00:00:00.000Z').filter(
        ({ observation }) => observation.event,
      ),
    ).toHaveLength(0)
    expect(
      db().query<{ count: number }, []>('SELECT count(*) count FROM task_status_event').get()
        ?.count,
    ).toBe(1)
  })

  test('mirrors a fresh task and exactly the transition it records', async () => {
    observeTrackerTask({ ...task, status: 'Open', category: 'open' })
    const taskRows: Parameters<CollectorMirrorPass['mirrorTasks']>[0][number][] = []
    const eventRows: Parameters<CollectorMirrorPass['mirrorStatusEvents']>[0][number][] = []

    await refreshTrackerTask('FIX-1', undefined, {
      ...dependencies(async () => task),
      lease: withLease,
      observe: observeTrackerTask,
      readBack: showTask,
      createMirror: async () => ({
        mirrorTasks: async (rows) => {
          taskRows.push(...rows)
        },
        mirrorStatusEvents: async (rows) => {
          eventRows.push(...rows)
        },
        reportSkipped: () => {},
      }),
    })

    const localEvent = db()
      .query<{ record_id: string; task_record_id: string }, []>(
        'SELECT record_id,task_record_id FROM task_status_event',
      )
      .get()!
    expect(taskRows).toHaveLength(1)
    expect(taskRows[0]).toMatchObject({
      record_id: localEvent.task_record_id,
      key: 'FIX-1',
      project: 'fixture',
      status_category: 'active',
    })
    expect(eventRows).toEqual([
      expect.objectContaining({
        id: localEvent.record_id,
        task_key: 'FIX-1',
        task_id: localEvent.task_record_id,
        project_name: 'fixture',
        from_status: 'open',
        to_status: 'active',
      }),
    ])

    expect(
      writeTrackerCache([task], '2026-10-05T00:00:00.000Z').filter(
        ({ observation }) => observation.event,
      ),
    ).toHaveLength(0)
    expect(eventRows).toHaveLength(1)
  })

  test('mirrors an unchanged fresh task without a status event', async () => {
    observeTrackerTask(task)
    const taskRows: Parameters<CollectorMirrorPass['mirrorTasks']>[0][number][] = []
    const eventRows: Parameters<CollectorMirrorPass['mirrorStatusEvents']>[0][number][] = []

    await refreshTrackerTask('FIX-1', undefined, {
      ...dependencies(async () => task),
      lease: withLease,
      observe: observeTrackerTask,
      readBack: showTask,
      createMirror: async () => ({
        mirrorTasks: async (rows) => {
          taskRows.push(...rows)
        },
        mirrorStatusEvents: async (rows) => {
          eventRows.push(...rows)
        },
        reportSkipped: () => {},
      }),
    })

    expect(taskRows).toHaveLength(1)
    expect(eventRows).toHaveLength(0)
  })

  test('a mirror failure keeps the fresh read and local transition successful', async () => {
    observeTrackerTask({ ...task, status: 'Open', category: 'open' })
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await refreshTrackerTask('FIX-1', undefined, {
        ...dependencies(async () => task),
        lease: withLease,
        observe: observeTrackerTask,
        readBack: showTask,
        createMirror: async () => ({
          mirrorTasks: async () => {
            throw new Error('Authorization: Bearer secret-value')
          },
          mirrorStatusEvents: async () => {},
          reportSkipped: () => {},
        }),
      })

      expect(result.shown?.task.key).toBe('FIX-1')
      expect(
        db().query<{ count: number }, []>('SELECT count(*) count FROM task_status_event').get()
          ?.count,
      ).toBe(1)
      const detail = errors.mock.calls.map((call) => String(call[0])).join('\n')
      expect(detail).toContain('tracker task mirror skipped')
      expect(detail).toContain('[redacted]')
      expect(detail).not.toContain('secret-value')
      expect(detail).not.toContain('Authorization')
    } finally {
      errors.mockRestore()
    }
  })

  test('an unchanged fresh task records no category event', async () => {
    expect(observeTrackerTask(task).event).toBeNull()

    await refreshTrackerTask('FIX-1', undefined, {
      ...dependencies(async () => task),
      lease: withLease,
      observe: observeTrackerTask,
      readBack: showTask,
    })
    expect(
      db().query<{ count: number }, []>('SELECT count(*) count FROM task_status_event').get()
        ?.count,
    ).toBe(0)
  })

  test('a mirror that never resolves is bounded and the fresh read still succeeds', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await refreshTrackerTask('FIX-1', undefined, {
        ...dependencies(async () => task),
        lease: withLease,
        observe: observeTrackerTask,
        readBack: showTask,
        mirrorTimeoutMs: 5,
        createMirror: async () => ({
          mirrorTasks: () => new Promise<void>(() => {}),
          mirrorStatusEvents: async () => {},
          reportSkipped: () => {},
        }),
      })
      expect(result.shown?.task.key).toBe('FIX-1')
      expect(errors.mock.calls.map((call) => String(call[0])).join('\n')).toContain(
        'mirror timed out after 5ms',
      )
    } finally {
      errors.mockRestore()
    }
  })
})
