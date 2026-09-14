import { beforeAll, describe, expect, test } from 'bun:test'
import { trackerPresentation } from '../projects.ts'
import { showTask } from '../task.ts'
import { ingestTrackers, resolveAssigneeIds, trackerRegistrations, upsertTrackerTask } from './trackers.ts'
import { resetFixtureStore } from '../../test/run-fixtures.ts'

beforeAll(resetFixtureStore)

describe('tracker register', () => {
  test('only projects that declare a usable tracker are polled', async () => {
    const results = await ingestTrackers()
    expect(results.map((result) => result.project)).toEqual(['alpha'])
    expect(results[0]!.skipped).toContain('FIXTURE_NO_CREDENTIALS_MCP_URL')
  })

  test('an unusable tracker remains an error beside a usable source', () => {
    const rows = [
      {
        id: 1, name: 'working', path: '/working', stack: null, canon: true,
        settings: { tracker: { protocol: 'array-mcp', envPrefix: 'WORKING' } },
      },
      {
        id: 2, name: 'broken', path: '/broken', stack: null, canon: true,
        settings: { tracker: { protocol: 'future-mcp', envPrefix: 'BROKEN' } },
      },
    ]
    const registrations = trackerRegistrations(rows)

    expect(registrations).toHaveLength(2)
    expect(registrations[0]).toMatchObject({ project: 'working', source: { env: 'WORKING' } })
    expect(registrations[1]).toEqual({
      project: 'broken',
      error: 'project broken tracker has unrecognised protocol future-mcp',
    })
  })

  test('presentation distinguishes configured, unusable, and absent trackers', () => {
    expect(trackerPresentation({ name: 'working', settings: {
      tracker: { protocol: 'array-mcp', envPrefix: 'WORKING' },
    } })).toEqual({ state: 'configured', label: 'array-mcp', error: null })
    expect(trackerPresentation({ name: 'adanim', settings: {
      tracker: { kind: 'adanim', protocol: 'array-mcp' },
    } })).toEqual({
      state: 'unusable', label: 'adanim',
      error: 'project adanim tracker is missing envPrefix',
    })
    expect(trackerPresentation({ name: 'untracked', settings: {} }))
      .toEqual({ state: 'not-configured', label: 'none', error: null })
  })
})

describe('tracker assignees', () => {
  test('resolves an id once and reuses the cached display name', async () => {
    const cache = new Map<string, string | null>()
    let calls = 0
    const lookup = async () => { calls++; return 'Ada Lovelace' }
    expect(await resolveAssigneeIds([{ id: 2 }], cache, lookup)).toEqual(['Ada Lovelace'])
    expect(await resolveAssigneeIds([{ id: 2 }], cache, lookup)).toEqual(['Ada Lovelace'])
    expect(calls).toBe(1)
  })

  test('caches an id that does not resolve', async () => {
    const cache = new Map<string, string | null>()
    let calls = 0
    const lookup = async () => { calls++; return null }
    expect(await resolveAssigneeIds([{ id: 'missing' }], cache, lookup)).toEqual([null])
    expect(await resolveAssigneeIds([{ id: 'missing' }], cache, lookup)).toEqual([null])
    expect(calls).toBe(1)
  })

  test('a tracker reporting no assignee makes no lookup and leaves null', async () => {
    let calls = 0
    const names = await resolveAssigneeIds([{}], new Map(), async () => { calls++; return 'wrong' })
    expect(names).toEqual([null])
    expect(calls).toBe(0)

    upsertTrackerTask({
      key: 'ALP-899', project: 'alpha', title: 'No assignment field', status: 'started',
      category: 'active', updatedAt: null, assignee: null,
    })
    expect(showTask('ALP-899').task.assignee).toBeNull()
  })
})
