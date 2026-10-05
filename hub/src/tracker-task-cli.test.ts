import { beforeEach, describe, expect, test } from 'bun:test'
import type { TrackerSource, TrackerTask } from '../../shared/trackers.ts'
import { resetFixtureStore } from '../test/run-fixtures.ts'
import { acquireLease, releaseLease, withLease } from './collect.ts'
import { db } from './db.ts'
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

const dependencies = (lookup: TrackerSource['lookup']) => ({
  registeredProjects: () => [project],
  sourceFor: () => source(lookup),
  readCredentials: async () => ({ url: 'https://tracker.invalid/mcp', token: 'secret-value' }),
  connect: async () => ({
    callTool: async () => ({}),
    close: async () => {},
  }),
  lease: async <T>(_holder: string, fn: () => Promise<T>) => ({
    ran: true as const,
    value: await fn(),
  }),
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
        return false
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
      observe: () => false,
    })
    await started

    const collect = await withLease('collect:fixture', async () => {}, 0)
    expect(collect.ran).toBeFalse()
    if (!collect.ran) expect(collect.heldBy).toStartWith('fresh-task:FIX-1:')
    releaseLookup()
    await fresh
  })

  test('records one first-observed category change and the following collect records none', async () => {
    expect(observeTrackerTask({ ...task, status: 'Open', category: 'open' })).toBeFalse()

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
    expect(writeTrackerCache([task], '2026-10-05T00:00:00.000Z')).toBe(0)
    expect(
      db().query<{ count: number }, []>('SELECT count(*) count FROM task_status_event').get()
        ?.count,
    ).toBe(1)
  })

  test('an unchanged fresh task records no category event', async () => {
    expect(observeTrackerTask(task)).toBeFalse()

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
})
