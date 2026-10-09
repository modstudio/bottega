import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { resolveAssigneeIds } from '../../../shared/trackers.ts'
import { resetFixtureStore } from '../../test/run-fixtures.ts'
import { db, writeTransaction } from '../db.ts'
import { trackerPresentation } from '../projects.ts'
import { showTask } from '../task.ts'
import { taskIdentityDoctor } from '../task-identity.ts'
import {
  ingestTrackers,
  type TrackerTask,
  trackerCredentials,
  trackerLegError,
  trackerObservationTimes,
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

  test('an unchanged done lookup preserves its stored closure time', () => {
    const done = { ...trackerTask, status: 'completed', category: 'done' as const }
    const closedAt = '2026-09-02T12:00:00.000Z'
    const stored = {
      ...storedTrackerTask,
      status: done.status,
      status_category: done.category,
      closed_at: closedAt,
    }
    expect(trackerObservationTimes(done, stored, at).closedAt).toBe(closedAt)
    expect(
      trackerObservationTimes({ ...done, title: 'Changed done task' }, stored, at).closedAt,
    ).toBe(at)
  })
})

const recordApiUrl = process.env.ORCH_RECORD_API_URL
beforeAll(() => {
  delete process.env.ORCH_RECORD_API_URL
  resetFixtureStore()
})
afterAll(() => {
  if (recordApiUrl === undefined) delete process.env.ORCH_RECORD_API_URL
  else process.env.ORCH_RECORD_API_URL = recordApiUrl
})

describe('tracker register', () => {
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
        name: 'working',
        path: '/working',
        stack: null,
        canon: true,
        repository: true,
        settings: { tracker: { protocol: 'array-mcp', envPrefix: 'WORKING' } },
      },
      {
        id: 2,
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

describe('tracker assignees', () => {
  test('a second unchanged observation preserves repaired machine times', () => {
    const firstAt = '2026-09-23T10:00:00.000Z'
    const secondAt = '2026-09-24T10:00:00.000Z'
    cacheTrackerTask(trackerTask, firstAt)
    cacheTrackerTask(trackerTask, secondAt)

    expect(
      db()
        .query<{ opened_at: string; updated_at: string; closed_at: string | null }, []>(
          "SELECT opened_at,updated_at,closed_at FROM task WHERE key='ALP-1'",
        )
        .get(),
    ).toEqual({ opened_at: firstAt, updated_at: firstAt, closed_at: null })
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
    expect({ taskKey: second.observation.taskKey, times: second.observation.times }).toEqual({
      taskKey: first.observation.taskKey,
      times: first.observation.times,
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
