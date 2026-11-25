import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { clearRecordSessionToken, writeRecordSessionToken } from '../../../shared/record-session.ts'
import { ToolCallRefused } from '../../../shared/tracker-list-scope.ts'
import {
  resolveAssigneeIds,
  type TrackerSource,
  trackerSourceFor,
} from '../../../shared/trackers.ts'
import { declareFixtureProjectSpace } from '../../test/fixture-project-space.ts'
import { resetFixtureStore } from '../../test/run-fixtures.ts'
import { db, writeTransaction } from '../db.ts'
import { trackerPresentation } from '../projects.ts'
import { showTask } from '../task.ts'
import { taskIdentityDoctor } from '../task-identity.ts'
import { trackerObservationTimes } from './tracker-observation-times.ts'
import {
  recordTrackerReadState,
  storedTrackerPageSize,
  storedTrackerReadMode,
  trackerProjectsReadSince,
  trackerReadPassComplete,
} from './tracker-read-state.ts'
import { finishTrackerResults, trackerLegError } from './tracker-result.ts'
import {
  collectTrackerSource,
  dropDeletedTrackerTasks,
  fetchTrackerTasks,
  ingestTrackers,
  retireOutOfScopeTrackerTasks,
  type TrackerTask,
  trackerCredentials,
  trackerKeyInScope,
  trackerKeyPrefix,
  trackerRegistrations,
  writeTrackerCache,
} from './trackers.ts'

const trackerTask = {
  externalId: 'tracker-alpha-1',
  key: 'ALP-1',
  project: 'alpha' as const,
  parentKey: undefined,
  title: 'Observed task',
  status: 'started',
  category: 'active' as const,
  updatedAt: null,
  assignee: null,
}

declareFixtureProjectSpace('alpha', 'fixture-space')
const storedTrackerTask = {
  external_id: trackerTask.externalId,
  key: trackerTask.key,
  project: trackerTask.project,
  parent_key: null,
  title: trackerTask.title,
  status: trackerTask.status,
  status_category: trackerTask.category,
  opened_at: '2026-09-01T10:00:00.000Z',
  closed_at: null,
  first_seen: '2026-09-01T10:00:00.000Z',
  last_seen: '2026-09-02T10:00:00.000Z',
  updated_at: '2026-09-01T10:00:00.000Z',
  assignee: null,
  retired_reason: null,
}

const cacheTrackerTask = (task: TrackerTask, at = new Date().toISOString()) =>
  writeTrackerCache([task], at, [])
const settingValue = (key: string) =>
  db().query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?').get(key)
    ?.value ?? null

describe('tracker observation times', () => {
  const at = '2026-09-03T10:00:00.000Z'

  test('new and changed observations use the pass time when the tracker has no update time', () => {
    expect(trackerObservationTimes(trackerTask, undefined, at)).toEqual({
      openedAt: at,
      closedAt: null,
      firstSeen: at,
      lastSeen: at,
      updatedAt: at,
    })
    expect(
      trackerObservationTimes({ ...trackerTask, title: 'Changed task' }, storedTrackerTask, at),
    ).toEqual({
      openedAt: at,
      closedAt: null,
      firstSeen: storedTrackerTask.first_seen,
      lastSeen: at,
      updatedAt: at,
    })
  })

  test('an unchanged observation sends every stored time', () => {
    expect(trackerObservationTimes(trackerTask, storedTrackerTask, at)).toEqual({
      openedAt: storedTrackerTask.opened_at,
      closedAt: storedTrackerTask.closed_at,
      firstSeen: storedTrackerTask.first_seen,
      lastSeen: storedTrackerTask.last_seen,
      updatedAt: storedTrackerTask.updated_at,
    })
  })

  test('an unchanged legacy row repairs missing update and open times once', () => {
    const legacy = { ...storedTrackerTask, opened_at: null, updated_at: null }
    const repaired = trackerObservationTimes(trackerTask, legacy, at)
    expect(repaired).toEqual({
      openedAt: at,
      closedAt: legacy.closed_at,
      firstSeen: legacy.first_seen,
      lastSeen: legacy.last_seen,
      updatedAt: at,
    })

    const secondAt = '2026-09-04T10:00:00.000Z'
    expect(
      trackerObservationTimes(
        trackerTask,
        { ...legacy, opened_at: repaired.openedAt, updated_at: repaired.updatedAt },
        secondAt,
      ),
    ).toEqual(repaired)
  })

  test('a tracker update time is retained for new, changed, and unchanged observations', () => {
    const updatedAt = '2026-09-03T09:30:00.000Z'
    const supplied = { ...trackerTask, updatedAt }
    const stored = { ...storedTrackerTask, updated_at: updatedAt, opened_at: updatedAt }
    expect(trackerObservationTimes(supplied, undefined, at).updatedAt).toBe(updatedAt)
    expect(trackerObservationTimes({ ...supplied, title: 'Changed task' }, stored, at)).toEqual({
      openedAt: updatedAt,
      closedAt: null,
      firstSeen: stored.first_seen,
      lastSeen: at,
      updatedAt,
    })
    expect(trackerObservationTimes(supplied, stored, at)).toEqual({
      openedAt: updatedAt,
      closedAt: null,
      firstSeen: stored.first_seen,
      lastSeen: stored.last_seen,
      updatedAt,
    })
  })

  test('re-observing done work preserves its lifecycle times while an open task closes now', () => {
    const done = { ...trackerTask, status: 'completed', category: 'done' as const }
    const closedAt = '2026-09-02T12:00:00.000Z'
    const stored = {
      ...storedTrackerTask,
      status: done.status,
      status_category: done.category,
      closed_at: closedAt,
    }
    expect(trackerObservationTimes(done, stored, at)).toMatchObject({
      openedAt: stored.opened_at,
      closedAt,
    })
    expect(
      trackerObservationTimes({ ...done, title: 'Changed done task', updatedAt: at }, stored, at),
    ).toMatchObject({ openedAt: stored.opened_at, closedAt })
    expect(trackerObservationTimes(done, storedTrackerTask, at).closedAt).toBe(at)
  })
})

describe('tracker key scope', () => {
  test('matches declared prefixes case-insensitively and admits every key without declarations', () => {
    expect(trackerKeyInScope('ALP-1', ['ALP'])).toBe(true)
    expect(trackerKeyInScope('alp-1', ['ALP'])).toBe(true)
    expect(trackerKeyInScope('BET-1', ['ALP'])).toBe(false)
    expect(trackerKeyPrefix('ALP-1')).toBe('ALP')
    expect(trackerKeyPrefix('ALP')).toBe('ALP')
    expect(trackerKeyInScope('ALP', ['ALP'])).toBe(true)
    expect(trackerKeyInScope('ALP', ['STAR'])).toBe(false)
    expect(trackerKeyInScope('anything', [])).toBe(true)
  })
})

const recordApiUrl = process.env.BOTTEGA_RECORD_API_URL
const hostedUrl = process.env.BOTTEGA_HOSTED_URL
const keyStore = process.env.BOTTEGA_KEYSTORE
beforeAll(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
  delete process.env.BOTTEGA_HOSTED_URL
  process.env.BOTTEGA_KEYSTORE = 'file'
  resetFixtureStore()
})
afterAll(() => {
  if (recordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = recordApiUrl
  if (hostedUrl === undefined) delete process.env.BOTTEGA_HOSTED_URL
  else process.env.BOTTEGA_HOSTED_URL = hostedUrl
  if (keyStore === undefined) delete process.env.BOTTEGA_KEYSTORE
  else process.env.BOTTEGA_KEYSTORE = keyStore
})

describe('tracker register', () => {
  const source = (
    supportsUpdatedSince: boolean,
    fetch: TrackerSource['fetch'],
    project = 'alpha',
  ): TrackerSource => ({
    project,
    env: 'FIXTURE',
    supportsUpdatedSince,
    fetch,
  })

  test('incremental reads skip vanished lookups while undeclared reads keep the full behavior', async () => {
    cacheTrackerTask({ ...trackerTask, externalId: 'incremental-task', key: 'ALP-INCREMENTAL' })
    let lookups = 0
    const incremental = source(true, async () => ({ tasks: [], complete: true, deletedKeys: [] }))
    incremental.lookup = async () => {
      lookups++
      return null
    }
    await fetchTrackerTasks(
      incremental,
      { callTool: async () => ({}) },
      'incremental',
      'cursor',
      [],
    )
    expect(lookups).toBe(0)

    const full = { ...incremental, supportsUpdatedSince: false }
    await fetchTrackerTasks(full, { callTool: async () => ({}) }, 'full', null, [])
    expect(lookups).toBe(1)
  })

  test('full reads do not look up keys reported as deleted', async () => {
    cacheTrackerTask({
      ...trackerTask,
      externalId: 'deleted-task',
      key: 'DEL-1',
      project: 'deleted',
    })
    let lookups = 0
    const full = source(
      false,
      async () => ({ tasks: [], complete: true, deletedKeys: ['DEL-1'] }),
      'deleted',
    )
    full.lookup = async () => {
      lookups++
      return null
    }

    await fetchTrackerTasks(full, { callTool: async () => ({}) }, 'full', null, [])
    expect(lookups).toBe(0)
  })

  test('a hosted full read takes vanished candidates from the hosted task list', async () => {
    cacheTrackerTask({
      ...trackerTask,
      externalId: 'local-only',
      key: 'LOCAL-ONLY',
    })
    const hostedTask = (
      key: string,
      statusCategory: 'active' | 'done',
      taskSource: 'mcp' | 'local' = 'mcp',
    ) => ({
      key,
      status_category: statusCategory,
      source: taskSource,
    })
    const listed = [
      hostedTask('HOST-VANISHED', 'active'),
      hostedTask('HOST-SEEN', 'active'),
      hostedTask('HOST-DONE', 'done'),
      hostedTask('HOST-LOCAL-SOURCE', 'active', 'local'),
    ]
    const projects: string[] = []
    const lookups: string[] = []
    const full = source(false, async () => ({
      tasks: [{ ...trackerTask, key: 'HOST-SEEN' }],
      complete: true,
      deletedKeys: [],
    }))
    full.lookup = async (_client, key) => {
      lookups.push(key)
      return { ...trackerTask, key }
    }

    const fetched = await fetchTrackerTasks(
      full,
      { callTool: async () => ({}) },
      'full',
      null,
      [],
      async (project) => {
        projects.push(project)
        return listed
      },
    )

    expect(projects).toEqual(['alpha'])
    expect(lookups).toEqual(['HOST-VANISHED'])
    expect(fetched.tasks.map((task) => task.key)).toEqual(['HOST-SEEN', 'HOST-VANISHED'])
  })

  test('full collection neither looks up nor writes out-of-scope tasks', async () => {
    const project = 'scope-guard'
    const at = '2026-11-09T10:00:00.000Z'
    const open = { ...trackerTask, externalId: 'guard-open', key: 'OPS-1', project }
    const retired = { ...trackerTask, externalId: 'guard-retired', key: 'OPS-2', project }
    cacheTrackerTask(open, at)
    cacheTrackerTask(retired, at)
    expect(retireOutOfScopeTrackerTasks(project, ['SCG'], at)).toBe(2)
    let lookups = 0
    const full = source(
      false,
      async () => ({ tasks: [retired], complete: true, deletedKeys: [] }),
      project,
    )
    full.lookup = async () => {
      lookups++
      return open
    }

    const fetched = await fetchTrackerTasks(full, { callTool: async () => ({}) }, 'full', null, [
      'SCG',
    ])
    expect(writeTrackerCache(fetched.tasks, '2026-11-09T11:00:00.000Z', ['SCG'])).toHaveLength(0)
    expect(lookups).toBe(0)
    expect(
      db()
        .query<{ key: string; status_category: string; retired_reason: string }, [string]>(
          'SELECT key,status_category,retired_reason FROM task WHERE project=? ORDER BY key',
        )
        .all(project),
    ).toEqual([
      {
        key: 'OPS-1',
        status_category: 'dropped',
        retired_reason:
          "out of scope: key prefix OPS is not among scope-guard's declared key prefixes SCG",
      },
      {
        key: 'OPS-2',
        status_category: 'dropped',
        retired_reason:
          "out of scope: key prefix OPS is not among scope-guard's declared key prefixes SCG",
      },
    ])
  })

  test.each(['incremental', 'full'] as const)(
    '%s reads drop cached tasks reported deleted',
    async (mode) => {
      const project = `deleted-${mode}`
      const key = mode === 'full' ? 'DEL-FULL' : 'DEL-INCREMENTAL'
      cacheTrackerTask({ ...trackerTask, externalId: key.toLowerCase(), key, project })
      const fetched = await fetchTrackerTasks(
        source(
          true,
          async () => ({ tasks: [], complete: true, deletedKeys: [key, 'UNKNOWN-1'] }),
          project,
        ),
        { callTool: async () => ({}) },
        mode,
        mode === 'incremental' ? '2026-11-06T09:55:00.000Z' : null,
        [],
      )
      const at = '2026-11-06T10:00:00.000Z'

      expect(dropDeletedTrackerTasks(project, fetched.deletedKeys, at, []).dropped).toBe(1)
      expect(
        db()
          .query<{ status: string; status_category: string; closed_at: string }, [string, string]>(
            'SELECT status,status_category,closed_at FROM task WHERE project=? AND key=?',
          )
          .get(project, key),
      ).toEqual({ status: 'deleted', status_category: 'dropped', closed_at: at })
    },
  )

  test('cursor and full-read time advance only after a complete read', () => {
    const first = '2026-11-06T10:00:00.000Z'
    recordTrackerReadState('alpha', 'full', first, true)
    expect(
      storedTrackerReadMode(
        source(true, async () => ({ tasks: [], complete: true, deletedKeys: [] })),
        first,
      ),
    ).toEqual({
      mode: 'incremental',
      since: '2026-11-06T09:55:00.000Z',
    })

    const partial = '2026-11-06T11:00:00.000Z'
    recordTrackerReadState('alpha', 'incremental', partial, false)
    expect(
      storedTrackerReadMode(
        source(true, async () => ({ tasks: [], complete: true, deletedKeys: [] })),
        partial,
      ),
    ).toEqual({
      mode: 'full',
      since: '2026-11-06T09:55:00.000Z',
    })
    expect(settingValue('collect.tracker.alpha.full-at')).toBe(first)
  })

  test('full reads probe at double the remembered page size capped at the protocol default', () => {
    writeTransaction((conn) => {
      const write = conn.query('INSERT OR REPLACE INTO setting(key,value) VALUES (?,?)')
      write.run('collect.tracker.page-size-small.page-size', '20')
      write.run('collect.tracker.page-size-large.page-size', '80')
    })
    expect(storedTrackerPageSize('page-size-small', 'incremental')).toBe(20)
    expect(storedTrackerPageSize('page-size-small', 'full')).toBe(40)
    expect(storedTrackerPageSize('page-size-large', 'full')).toBe(100)
    expect(storedTrackerPageSize('page-size-missing', 'full')).toBe(100)
  })

  test('a successful adaptive read stores its working page size for the next incremental read', async () => {
    const adaptive = trackerSourceFor({
      name: 'alpha',
      settings: {
        tracker: {
          protocol: 'cursor-mcp',
          envPrefix: 'FIXTURE',
          openStatuses: ['todo'],
          states: { todo: 'open' },
          projectId: '019d9699-a223-729f-a032-50de9fdf4303',
        },
      },
    })!
    const pageSizes: number[] = []

    await collectTrackerSource(
      { project: 'alpha', prefixes: ['ALP'], source: adaptive },
      [],
      '2026-11-20T10:00:00.000Z',
      {
        listTools: async () => [
          { name: 'task_list', inputSchema: { properties: { projectId: {} } } },
        ],
        async callTool(_name: string, args: Record<string, unknown>) {
          const pageSize = args.limit as number
          pageSizes.push(pageSize)
          if (pageSize > 3) throw new ToolCallRefused('fixture page too large')
          return {
            data: {
              items: [{ id: 'adaptive-row', humanKey: 'ALP-ADAPTIVE', status: 'todo' }],
            },
          }
        },
      } as never,
    )

    expect(pageSizes).toEqual([100, 50, 25, 12, 6, 3])
    expect(settingValue('collect.tracker.alpha.page-size')).toBe('3')
    expect(storedTrackerPageSize('alpha', 'incremental')).toBe(3)
  })

  test('a failed list still backfills, records incomplete, and leaves retirements untouched', async () => {
    const project = 'failed-list'
    const existing = { ...trackerTask, externalId: 'existing', key: 'FL-1', project }
    cacheTrackerTask(existing, '2026-11-20T10:00:00.000Z')
    const source: TrackerSource = {
      project,
      env: 'FIXTURE',
      supportsUpdatedSince: false,
      fetch: async () => {
        throw new Error('list unavailable')
      },
      lookup: async (_client, key) => ({
        ...trackerTask,
        externalId: 'backfilled',
        key,
        project,
      }),
    }

    const collected = await collectTrackerSource(
      { project, prefixes: ['FL'], source },
      [{ task_key: 'FL-2', project }],
      '2026-11-20T11:00:00.000Z',
      { callTool: async () => ({}) } as never,
    )

    expect(collected).toMatchObject({
      result: { project, tasks: 0, changed: 0, error: 'list unavailable' },
      filled: 1,
    })
    expect(
      db()
        .query<{ key: string; status_category: string }, [string]>(
          'SELECT key,status_category FROM task WHERE project=? ORDER BY key',
        )
        .all(project),
    ).toEqual([
      { key: 'FL-1', status_category: 'active' },
      { key: 'FL-2', status_category: 'active' },
    ])
    expect(settingValue(`collect.tracker.${project}.force-full`)).toBe('1')
  })

  describe('hosted list failure', () => {
    const nodeEnv = process.env.NODE_ENV
    const originalFetch = globalThis.fetch

    beforeAll(() => {
      process.env.BOTTEGA_HOSTED_URL = 'https://hub.example.test'
      process.env.NODE_ENV = 'development'
      writeRecordSessionToken('fixture-token')
    })

    afterAll(() => {
      delete process.env.BOTTEGA_HOSTED_URL
      if (nodeEnv === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = nodeEnv
      globalThis.fetch = originalFetch
      clearRecordSessionToken()
      resetFixtureStore()
    })

    test('a refused hosted list still applies backfill without retirement and records failure', async () => {
      resetFixtureStore()
      delete process.env.BOTTEGA_HOSTED_URL
      cacheTrackerTask(
        { ...trackerTask, externalId: 'hosted-existing', key: 'ALP-1' },
        '2026-11-20T10:00:00.000Z',
      )
      process.env.BOTTEGA_HOSTED_URL = 'https://hub.example.test'
      const sent: Array<Record<string, unknown>> = []
      globalThis.fetch = (async (_input, init) => {
        const changes = JSON.parse(String(init?.body)) as Array<Record<string, unknown>>
        sent.push(...changes)
        return Response.json(changes.map((change) => ({ id: change.id, status: 'applied' })))
      }) as typeof fetch
      const tracker = source(false, async () => {
        throw new Error('list refused')
      })
      tracker.lookup = async (_client, key) => ({
        ...trackerTask,
        externalId: 'hosted-backfill',
        key,
      })

      const collected = await collectTrackerSource(
        { project: 'alpha', prefixes: ['ALP'], source: tracker },
        [{ task_key: 'ALP-2', project: 'alpha' }],
        '2026-11-20T11:00:00.000Z',
        { callTool: async () => ({}) } as never,
      )
      finishTrackerResults([collected], '2026-11-20T11:00:00.000Z', ['alpha'])

      const rows = db()
        .query<{ key: string; retired_reason: string | null }, [string]>(
          'SELECT key,retired_reason FROM task WHERE project=? ORDER BY key',
        )
        .all('alpha')
      expect(rows).toEqual([
        { key: 'ALP-1', retired_reason: null },
        { key: 'ALP-2', retired_reason: null },
      ])
      expect(sent).toHaveLength(1)
      expect(sent[0]).toMatchObject({ table: 'hub_task', row: { key: 'ALP-2' } })
      expect(settingValue('collect.tracker.alpha.force-full')).toBe('1')
      expect(settingValue('collect.leg.tasks%3Aalpha')).toContain('"consecutiveFailures":1')
    })
  })

  test('a refused hosted change keeps the cursor and forces the next read to be full', () => {
    const first = '2026-11-06T10:00:00.000Z'
    recordTrackerReadState('refused', 'full', first, true)
    const tracker = source(
      true,
      async () => ({ tasks: [], complete: true, deletedKeys: [] }),
      'refused',
    )
    const before = storedTrackerReadMode(tracker, first)

    recordTrackerReadState(
      'refused',
      'incremental',
      '2026-11-06T11:00:00.000Z',
      trackerReadPassComplete(true, ['task-id: fixture refusal']),
    )

    expect(storedTrackerReadMode(tracker, '2026-11-06T11:00:00.000Z')).toEqual({
      mode: 'full',
      since: before.since,
    })
  })

  test('a repeated deletion report keeps the first drop and a closed task keeps its closure', () => {
    const project = 'deleted-repeat'
    cacheTrackerTask({ ...trackerTask, externalId: 'del-open', key: 'DEL-OPEN', project })
    cacheTrackerTask({
      ...trackerTask,
      externalId: 'del-done',
      key: 'DEL-DONE',
      project,
      status: 'done',
      category: 'done',
    })
    const closedBefore = db()
      .query<{ closed_at: string }, [string, string]>(
        'SELECT closed_at FROM task WHERE project=? AND key=?',
      )
      .get(project, 'DEL-DONE')?.closed_at
    const first = '2026-11-06T10:00:00.000Z'

    expect(dropDeletedTrackerTasks(project, ['DEL-OPEN', 'DEL-DONE'], first, []).dropped).toBe(2)
    expect(
      dropDeletedTrackerTasks(project, ['DEL-OPEN'], '2026-11-06T10:05:00.000Z', []).dropped,
    ).toBe(0)
    const rows = db()
      .query<{ key: string; closed_at: string }, [string]>(
        'SELECT key,closed_at FROM task WHERE project=? ORDER BY key',
      )
      .all(project)
    expect(rows).toEqual([
      { key: 'DEL-DONE', closed_at: closedBefore ?? first },
      { key: 'DEL-OPEN', closed_at: first },
    ])
  })

  test('an incomplete incremental read leaves since unchanged and forces a full read', () => {
    const first = '2026-11-06T12:00:00.000Z'
    recordTrackerReadState('incomplete', 'full', first, true)
    const tracker = source(
      true,
      async () => ({ tasks: [], complete: false, deletedKeys: [] }),
      'incomplete',
    )
    const before = storedTrackerReadMode(tracker, first)

    recordTrackerReadState('incomplete', 'incremental', '2026-11-06T13:00:00.000Z', false)

    expect(storedTrackerReadMode(tracker, '2026-11-06T13:00:00.000Z')).toEqual({
      mode: 'full',
      since: before.since,
    })
  })

  test('successful reads record per-project freshness and failures do not', () => {
    const at = '2026-10-01T12:00:00.000Z'
    finishTrackerResults(
      [
        { result: { project: 'fresh', tasks: 2, changed: 0 }, filled: 0 },
        { result: { project: 'failed', tasks: 0, changed: 0, error: 'down' }, filled: 0 },
        { result: { project: 'skipped', tasks: 0, changed: 0, skipped: 'no key' }, filled: 0 },
      ],
      at,
      ['fresh', 'failed', 'skipped'],
    )
    writeTransaction((conn) =>
      conn
        .query('INSERT OR REPLACE INTO setting(key,value) VALUES (?,?)')
        .run('collect.tracker.stale.at', '2026-09-01T12:00:00.000Z'),
    )

    expect(
      trackerProjectsReadSince(
        ['fresh', 'stale', 'failed', 'skipped', 'never'],
        Date.parse(at) - 1,
      ),
    ).toEqual(new Set(['fresh']))
  })

  test('a synthetic backfill result records no collector leg and an empty pass records no completion', () => {
    resetFixtureStore()
    finishTrackerResults(
      [{ result: { project: 'alpha', tasks: 0, changed: 0 }, filled: 1 }],
      '2026-10-01T12:00:00.000Z',
      ['alpha'],
    )
    expect(settingValue('collect.leg.tasks%3Abackfill')).toBeNull()

    resetFixtureStore()
    finishTrackerResults([], '2026-10-01T13:00:00.000Z', [])
    expect(settingValue('collect.trackers.at')).toBeNull()
  })

  test('only projects that declare a usable tracker are polled', async () => {
    const results = await ingestTrackers()
    expect(results.map((result) => result.project)).toEqual(['alpha'])
    expect(results[0]!.skipped).toContain('FIXTURE_NO_CREDENTIALS_MCP_URL')
    expect(settingValue('collect.trackers.at')).toBeString()
    expect(trackerLegError(results)).toBeNull()
  })

  test('only tracker errors fail the tasks leg', () => {
    expect(
      trackerLegError([{ project: 'missing', tasks: 0, changed: 0, skipped: 'not configured' }]),
    ).toBeNull()
    expect(trackerLegError([{ project: 'down', tasks: 0, changed: 0, error: 'unreachable' }])).toBe(
      'down: unreachable',
    )
  })

  test('an unusable tracker remains an error beside a usable source', () => {
    const rows = [
      {
        id: 1,
        record_id: '01990000-0000-7000-8000-000000001201',
        name: 'working',
        path: '/working',
        stack: null,
        canon: true,
        repository: true,
        settings: { tracker: { protocol: 'array-mcp', envPrefix: 'WORKING' } },
      },
      {
        id: 2,
        record_id: '01990000-0000-7000-8000-000000001202',
        name: 'broken',
        path: '/broken',
        stack: null,
        canon: true,
        repository: true,
        settings: { tracker: { protocol: 'future-mcp', envPrefix: 'BROKEN' } },
      },
    ]
    const registrations = trackerRegistrations(rows)

    expect(registrations).toHaveLength(2)
    expect(registrations[0]).toMatchObject({ project: 'working', source: { env: 'WORKING' } })
    expect(registrations[1]).toEqual({
      project: 'broken',
      error: 'project broken tracker has unrecognized protocol future-mcp',
    })
  })

  test('a hosted credential refusal stays with its tracker while another resolves', async () => {
    const read = async (env: string) => {
      if (env === 'BROKEN') throw new Error('hosted secret BROKEN_MCP_TOKEN refused: missing-wrap')
      return { url: 'https://tracker.example/mcp', token: 'token' }
    }
    const results = await Promise.all([
      trackerCredentials('broken', 'BROKEN', read),
      trackerCredentials('working', 'WORKING', read),
    ])

    expect(results).toEqual([
      {
        project: 'broken',
        error: 'hosted secret BROKEN_MCP_TOKEN refused: missing-wrap',
      },
      {
        project: 'working',
        credentials: { url: 'https://tracker.example/mcp', token: 'token' },
      },
    ])
  })

  test('presentation distinguishes configured, unusable, and absent trackers', () => {
    expect(
      trackerPresentation({
        name: 'working',
        settings: {
          tracker: { protocol: 'array-mcp', envPrefix: 'WORKING' },
        },
      }),
    ).toEqual({ state: 'configured', label: 'array-mcp', error: null })
    expect(
      trackerPresentation({
        name: 'adanim',
        settings: {
          tracker: { kind: 'adanim', protocol: 'array-mcp' },
        },
      }),
    ).toEqual({
      state: 'unusable',
      label: 'adanim',
      error: 'project adanim tracker is missing envPrefix',
    })
    expect(trackerPresentation({ name: 'untracked', settings: {} })).toEqual({
      state: 'not-configured',
      label: 'none',
      error: null,
    })
  })
})

describe('out-of-scope tracker retirement', () => {
  test('retires once without status history, queues hosted state, and restores in scope', () => {
    const project = 'retirement'
    const openedAt = '2026-11-01T09:00:00.000Z'
    const at = '2026-11-09T10:00:00.000Z'
    const outOfScope = {
      ...trackerTask,
      externalId: 'retire-ops-1',
      key: 'OPS-1',
      project,
      status: 'in progress',
      updatedAt: openedAt,
    }
    const inScope = { ...trackerTask, externalId: 'retire-ret-1', key: 'RET-1', project }
    cacheTrackerTask(outOfScope, openedAt)
    cacheTrackerTask(inScope, openedAt)
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO task
           (record_id,key,project,title,status,status_category,source,first_seen,last_seen)
           VALUES ('retire-local','OPS-2',?,'Local','open','open','local',?,?)`,
        )
        .run(project, openedAt, openedAt),
    )

    expect(retireOutOfScopeTrackerTasks(project, ['RET', 'ALT'], at)).toBe(1)
    expect(
      db()
        .query<
          {
            status: string
            status_category: string
            opened_at: string
            closed_at: string
            retired_reason: string
          },
          [string, string]
        >(
          `SELECT status,status_category,opened_at,closed_at,retired_reason
           FROM task WHERE project=? AND key=?`,
        )
        .get(project, 'OPS-1'),
    ).toEqual({
      status: 'in progress',
      status_category: 'dropped',
      opened_at: openedAt,
      closed_at: at,
      retired_reason:
        "out of scope: key prefix OPS is not among retirement's declared key prefixes RET, ALT",
    })
    expect(
      db()
        .query<{ count: number }, [string]>(
          `SELECT count(*) count FROM task_status_event e
           JOIN task t ON t.record_id=e.task_record_id WHERE t.project=?`,
        )
        .get(project)?.count,
    ).toBe(0)
    expect(
      db()
        .query<{ row_id: string; operation: string }, [string]>(
          `SELECT row_id,operation FROM hosted_outbox
           WHERE table_name='hub_task' AND row_id=(SELECT record_id FROM task WHERE project=? AND key='OPS-1')`,
        )
        .all(project),
    ).toHaveLength(1)
    expect(retireOutOfScopeTrackerTasks(project, ['RET', 'ALT'], at)).toBe(0)
    expect(
      db()
        .query<{ count: number }, [string]>(
          `SELECT count(*) count FROM hosted_outbox
           WHERE table_name='hub_task' AND row_id=(SELECT record_id FROM task WHERE project=? AND key='OPS-1')`,
        )
        .get(project)?.count,
    ).toBe(1)
    expect(
      db()
        .query<{ status_category: string; retired_reason: string | null }, [string]>(
          `SELECT status_category,retired_reason FROM task
           WHERE project=? AND key IN ('RET-1','OPS-2') ORDER BY key`,
        )
        .all(project),
    ).toEqual([
      { status_category: 'open', retired_reason: null },
      { status_category: 'active', retired_reason: null },
    ])

    expect(writeTrackerCache([outOfScope], '2026-11-09T12:00:00.000Z', ['OPS'])).toHaveLength(1)
    expect(
      db()
        .query<{ status_category: string; retired_reason: string | null }, [string, string]>(
          'SELECT status_category,retired_reason FROM task WHERE project=? AND key=?',
        )
        .get(project, 'OPS-1'),
    ).toEqual({ status_category: 'active', retired_reason: null })
  })
})

describe('tracker assignees', () => {
  test('a second unchanged observation preserves repaired machine times', () => {
    const firstAt = '2026-09-23T10:00:00.000Z'
    const secondAt = '2026-09-24T10:00:00.000Z'
    cacheTrackerTask(trackerTask, firstAt)
    const second = cacheTrackerTask(trackerTask, secondAt)[0]!

    expect(
      db()
        .query<
          { opened_at: string; updated_at: string; closed_at: string | null; last_seen: string },
          []
        >("SELECT opened_at,updated_at,closed_at,last_seen FROM task WHERE key='ALP-1'")
        .get(),
    ).toEqual({ opened_at: firstAt, updated_at: firstAt, closed_at: null, last_seen: secondAt })
    expect(second.observation.times).toMatchObject({ openedAt: firstAt, updatedAt: firstAt })
  })

  test('resolves an id once and reuses the cached display name', async () => {
    const cache = new Map<string, string | null>()
    let calls = 0
    const lookup = async () => {
      calls++
      return 'Ada Lovelace'
    }
    expect(await resolveAssigneeIds([{ id: 2 }], cache, lookup)).toEqual(['Ada Lovelace'])
    expect(await resolveAssigneeIds([{ id: 2 }], cache, lookup)).toEqual(['Ada Lovelace'])
    expect(calls).toBe(1)
  })

  test('caches an id that does not resolve', async () => {
    const cache = new Map<string, string | null>()
    let calls = 0
    const lookup = async () => {
      calls++
      return null
    }
    expect(await resolveAssigneeIds([{ id: 'missing' }], cache, lookup)).toEqual([null])
    expect(await resolveAssigneeIds([{ id: 'missing' }], cache, lookup)).toEqual([null])
    expect(calls).toBe(1)
  })

  test('a tracker reporting no assignee makes no lookup and leaves null', async () => {
    let calls = 0
    const names = await resolveAssigneeIds([{}], new Map(), async () => {
      calls++
      return 'wrong'
    })
    expect(names).toEqual([null])
    expect(calls).toBe(0)

    cacheTrackerTask({
      externalId: 'tracker-alp-899',
      key: 'ALP-899',
      project: 'alpha',
      title: 'No assignment field',
      status: 'started',
      category: 'active',
      updatedAt: null,
      assignee: null,
    })
    expect((await showTask('ALP-899')).task.assignee).toBeNull()
    expect((await showTask('ALP-899')).task.external_id).toBe('tracker-alp-899')
    expect(
      db()
        .query<{ count: number }, []>(
          "SELECT COUNT(*) count FROM task_identity_claim WHERE key='ALP-899'",
        )
        .get()?.count,
    ).toBe(1)
  })

  test('a missing incoming external id advances the stored identity claim', () => {
    const task = {
      externalId: 'tracker-alp-900',
      key: 'ALP-900',
      project: 'alpha' as const,
      title: 'Retained tracker identity',
      status: 'started',
      category: 'active' as const,
      updatedAt: null,
      assignee: null,
    }
    cacheTrackerTask(task, '2026-09-23T10:00:00.000Z')
    cacheTrackerTask({ ...task, externalId: null }, '2026-09-24T10:00:00.000Z')

    expect(
      db()
        .query<{ external_id: string; last_seen: string }, []>(
          "SELECT external_id,last_seen FROM task_identity_claim WHERE key='ALP-900'",
        )
        .get(),
    ).toEqual({ external_id: 'tracker-alp-900', last_seen: '2026-09-24T10:00:00.000Z' })
  })

  test('the same label in two projects keeps distinct tracker identities', () => {
    const shared = {
      key: 'OPS-21',
      title: 'Shared label',
      status: 'started',
      category: 'active' as const,
      updatedAt: null,
      assignee: null,
    }
    cacheTrackerTask({ ...shared, project: 'starship', externalId: 'starship-21' })
    cacheTrackerTask({ ...shared, project: 'stopal', externalId: 'stopal-21' })

    expect(
      db()
        .query<{ project: string; external_id: string }, []>(
          `SELECT project,external_id FROM task WHERE key='OPS-21' ORDER BY project`,
        )
        .all(),
    ).toEqual([
      { project: 'starship', external_id: 'starship-21' },
      { project: 'stopal', external_id: 'stopal-21' },
    ])
  })

  test('a tracker external id claims an existing null-identity label row', () => {
    writeTransaction((conn) =>
      conn.exec(`
        INSERT INTO task(record_id,key,project,source,first_seen,last_seen)
        VALUES ('null-external-record','ALP-901','alpha','mcp','2026-01-01','2026-01-01')
      `),
    )

    cacheTrackerTask({
      externalId: 'tracker-alp-901',
      key: 'ALP-901',
      project: 'alpha',
      title: 'Claimed identity',
      status: 'started',
      category: 'active',
      updatedAt: null,
      assignee: null,
    })

    expect(
      db()
        .query(`SELECT record_id,external_id FROM task WHERE project='alpha' AND key='ALP-901'`)
        .all(),
    ).toEqual([{ record_id: 'null-external-record', external_id: 'tracker-alp-901' }])
  })

  test('an external-id match adopts the incoming tracker label and refreshes its claim', () => {
    const task = {
      externalId: 'tracker-rename-1',
      project: 'alpha' as const,
      title: 'Renamed task',
      status: 'started',
      category: 'active' as const,
      updatedAt: null,
      assignee: null,
    }
    cacheTrackerTask({ ...task, key: 'REN-1' })
    cacheTrackerTask({ ...task, key: 'REN-2' })

    expect(
      db()
        .query(`SELECT key FROM task WHERE project='alpha' AND external_id='tracker-rename-1'`)
        .get(),
    ).toEqual({ key: 'REN-2' })
    expect(
      db()
        .query(
          `SELECT key FROM task_identity_claim
           WHERE project='alpha' AND external_id='tracker-rename-1'`,
        )
        .get(),
    ).toEqual({ key: 'REN-2' })
  })

  test('a colliding tracker rename is reported, skipped, and converges on the next pass', () => {
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const task = {
      project: 'alpha' as const,
      title: 'Collision task',
      status: 'started',
      category: 'active' as const,
      updatedAt: null,
      assignee: null,
    }
    cacheTrackerTask({ ...task, externalId: 'collision-target', key: 'COL-OLD' })
    cacheTrackerTask({ ...task, externalId: 'collision-holder', key: 'COL-NEW' })

    const renamed = { ...task, externalId: 'collision-target', key: 'COL-NEW' }
    const first = writeTrackerCache([renamed], '2026-09-23T10:00:00.000Z', [])[0]!
    const afterFirst = db()
      .query<{ opened_at: string; updated_at: string }, []>(
        `SELECT opened_at,updated_at FROM task WHERE external_id='collision-target'`,
      )
      .get()
    const second = writeTrackerCache([renamed], '2026-09-24T10:00:00.000Z', [])[0]!
    expect(error).toHaveBeenCalledTimes(2)
    expect(db().query(`SELECT key FROM task WHERE external_id='collision-target'`).get()).toEqual({
      key: 'COL-OLD',
    })
    expect(
      db()
        .query(`SELECT opened_at,updated_at FROM task WHERE external_id='collision-target'`)
        .get(),
    ).toEqual(afterFirst)
    expect({
      taskKey: second.observation.taskKey,
      openedAt: second.observation.times.openedAt,
      updatedAt: second.observation.times.updatedAt,
    }).toEqual({
      taskKey: first.observation.taskKey,
      openedAt: first.observation.times.openedAt,
      updatedAt: first.observation.times.updatedAt,
    })
    expect(
      db()
        .query<{ count: number }, []>(
          `SELECT COUNT(*) count FROM task_identity_migration_repairs
           WHERE reason='tracker label collision'`,
        )
        .get()?.count,
    ).toBe(1)
    expect(taskIdentityDoctor().collidedKeyUncertainties).toBe(1)

    cacheTrackerTask({ ...task, externalId: 'collision-holder', key: 'COL-FREED' })
    cacheTrackerTask(renamed)
    expect(db().query(`SELECT key FROM task WHERE external_id='collision-target'`).get()).toEqual({
      key: 'COL-NEW',
    })
    expect(
      db()
        .query<{ count: number }, []>(
          `SELECT COUNT(*) count FROM task_identity_migration_repairs
           WHERE reason='tracker label collision'`,
        )
        .get()?.count,
    ).toBe(0)
    expect(taskIdentityDoctor().collidedKeyUncertainties).toBe(0)
    error.mockRestore()
  })
})

// restore the store this file bound or queued into, so the next file starts clean
afterAll(resetFixtureStore)
