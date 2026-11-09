import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { resolveAssigneeIds, type TrackerSource } from '../../../shared/trackers.ts'
import { resetFixtureStore } from '../../test/run-fixtures.ts'
import { db, writeTransaction } from '../db.ts'
import { trackerPresentation } from '../projects.ts'
import { showTask } from '../task.ts'
import { taskIdentityDoctor } from '../task-identity.ts'
import {
  dropDeletedTrackerTasks,
  fetchTrackerTasks,
  finishTrackerResults,
  ingestTrackers,
  recordTrackerReadState,
  retireOutOfScopeTrackerTasks,
  storedTrackerReadMode,
  type TrackerTask,
  trackerCredentials,
  trackerKeyInScope,
  trackerLegError,
  trackerObservationTimes,
  trackerProjectsReadSince,
  trackerRegistrations,
  writeTrackerCache,
} from './trackers.ts'

const trackerTask = {
  externalId: 'tracker-alpha-1',
  key: 'ALP-1',
  project: 'alpha' as const,
  title: 'Observed task',
  status: 'started',
  category: 'active' as const,
  updatedAt: null,
  assignee: null,
}
const storedTrackerTask = {
  external_id: trackerTask.externalId,
  key: trackerTask.key,
  project: trackerTask.project,
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
  writeTrackerCache([task], at)

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
    expect(trackerKeyInScope('ALP', ['ALP'])).toBe(false)
    expect(trackerKeyInScope('anything', [])).toBe(true)
  })
})

const recordApiUrl = process.env.BOTTEGA_RECORD_API_URL
const keyStore = process.env.BOTTEGA_KEYSTORE
beforeAll(() => {
  delete process.env.BOTTEGA_RECORD_API_URL
  process.env.BOTTEGA_KEYSTORE = 'file'
  resetFixtureStore()
})
afterAll(() => {
  if (recordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
  else process.env.BOTTEGA_RECORD_API_URL = recordApiUrl
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
    await fetchTrackerTasks(incremental, { callTool: async () => ({}) }, 'incremental', 'cursor')
    expect(lookups).toBe(0)

    const full = { ...incremental, supportsUpdatedSince: false }
    await fetchTrackerTasks(full, { callTool: async () => ({}) }, 'full', null)
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

    await fetchTrackerTasks(full, { callTool: async () => ({}) }, 'full', null)
    expect(lookups).toBe(0)
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
      )
      const at = '2026-11-06T10:00:00.000Z'

      expect(dropDeletedTrackerTasks(project, fetched.deletedKeys, at).dropped).toBe(1)
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
    expect(
      db()
        .query<{ value: string }, []>(
          "SELECT value FROM setting WHERE key='collect.tracker.alpha.full-at'",
        )
        .get()?.value,
    ).toBe(first)
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

    expect(dropDeletedTrackerTasks(project, ['DEL-OPEN', 'DEL-DONE'], first).dropped).toBe(2)
    expect(dropDeletedTrackerTasks(project, ['DEL-OPEN'], '2026-11-06T10:05:00.000Z').dropped).toBe(
      0,
    )
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

  test('only projects that declare a usable tracker are polled', async () => {
    const results = await ingestTrackers()
    expect(results.map((result) => result.project)).toEqual(['alpha'])
    expect(results[0]!.skipped).toContain('FIXTURE_NO_CREDENTIALS_MCP_URL')
    expect(
      db()
        .query<{ value: string }, []>(`SELECT value FROM setting WHERE key='collect.trackers.at'`)
        .get()?.value,
    ).toBeString()
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
    expect(showTask('ALP-899').task.assignee).toBeNull()
    expect(showTask('ALP-899').task.external_id).toBe('tracker-alp-899')
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
    const first = writeTrackerCache([renamed], '2026-09-23T10:00:00.000Z')[0]!
    const afterFirst = db()
      .query<{ opened_at: string; updated_at: string }, []>(
        `SELECT opened_at,updated_at FROM task WHERE external_id='collision-target'`,
      )
      .get()
    const second = writeTrackerCache([renamed], '2026-09-24T10:00:00.000Z')[0]!
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
