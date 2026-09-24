import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { resolveAssigneeIds } from '../../../shared/trackers.ts'
import { resetFixtureStore } from '../../test/run-fixtures.ts'
import { db } from '../db.ts'
import { trackerPresentation } from '../projects.ts'
import { showTask } from '../task.ts'
import {
  ingestTrackers,
  trackerCredentials,
  trackerRegistrations,
  upsertTrackerTask,
} from './trackers.ts'

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
  })

  test('an unusable tracker remains an error beside a usable source', () => {
    const rows = [
      {
        id: 1,
        name: 'working',
        path: '/working',
        stack: null,
        canon: true,
        settings: { tracker: { protocol: 'array-mcp', envPrefix: 'WORKING' } },
      },
      {
        id: 2,
        name: 'broken',
        path: '/broken',
        stack: null,
        canon: true,
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

    upsertTrackerTask({
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
    upsertTrackerTask(task, '2026-09-23T10:00:00.000Z')
    upsertTrackerTask({ ...task, externalId: null }, '2026-09-24T10:00:00.000Z')

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
    upsertTrackerTask({ ...shared, project: 'starship', externalId: 'starship-21' })
    upsertTrackerTask({ ...shared, project: 'stopal', externalId: 'stopal-21' })

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
})
