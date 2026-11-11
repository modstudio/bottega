import { expect, test } from 'bun:test'
import { declareFixtureProjectSpace } from '../test/fixture-project-space.ts'
import type { HostedTask } from './hosted-tasks.ts'
import { confirmCount } from './hosted-tasks.ts'
import { pruneForeignHostedTasks, selectForeignHostedTasks } from './task-prune-foreign.ts'

declareFixtureProjectSpace('workshop', 'workshop')

const task = (key: string, project: string, source: HostedTask['source'] = 'mcp'): HostedTask => ({
  id: `id-${key}`,
  key,
  project,
  project_name: project,
  title: null,
  status: null,
  status_category: null,
  parent_key: null,
  body: null,
  assignee: null,
  opened_at: null,
  closed_at: null,
  source,
  first_seen: '2026-09-24T00:00:00.000Z',
  last_seen: '2026-09-24T00:00:00.000Z',
  created_at: '2026-09-24T00:00:00.000Z',
  updated_at: '2026-09-24T00:00:00.000Z',
  deleted_at: null,
  next_document_number: 1,
})

const identity = {
  userId: 'user-active',
  activeSpaceId: 'space-active',
  memberships: [
    { spaceId: 'space-active', slug: 'active', permission: 'write' },
    { spaceId: 'space-other', slug: 'other', permission: 'write' },
  ],
}

test('foreign task selection shares push space rules and reports own-space presence', () => {
  const tasks = [
    task('DEF-1', 'defaulted'),
    task('HERE-1', 'here'),
    task('OTHER-1', 'other'),
    task('MISSING-1', 'other'),
    task('LOST-1', 'unknown-space'),
    task('ORPHAN-1', 'unregistered'),
  ]
  const registered = [
    { name: 'defaulted', settings: {} },
    { name: 'here', settings: { space: 'active' } },
    { name: 'other', settings: { space: 'other' } },
    { name: 'unknown-space', settings: { space: 'not-a-membership' } },
  ]
  const selected = selectForeignHostedTasks(
    tasks,
    registered,
    identity,
    [{ space_id: 'space-other', key: 'OTHER-1' }],
    'space-active',
  )

  expect(selected).toEqual([
    {
      id: 'id-DEF-1',
      key: 'DEF-1',
      project: 'defaulted',
      source: 'mcp',
      present_elsewhere: null,
      target_space_id: null,
    },
    {
      id: 'id-OTHER-1',
      key: 'OTHER-1',
      project: 'other',
      source: 'mcp',
      present_elsewhere: true,
      target_space_id: 'space-other',
    },
    {
      id: 'id-MISSING-1',
      key: 'MISSING-1',
      project: 'other',
      source: 'mcp',
      present_elsewhere: false,
      target_space_id: 'space-other',
    },
    {
      id: 'id-LOST-1',
      key: 'LOST-1',
      project: 'unknown-space',
      source: 'mcp',
      present_elsewhere: null,
      target_space_id: null,
    },
    {
      id: 'id-ORPHAN-1',
      key: 'ORPHAN-1',
      project: 'unregistered',
      source: 'mcp',
      present_elsewhere: null,
      target_space_id: null,
    },
  ])
  expect(
    selectForeignHostedTasks(
      tasks,
      registered,
      identity,
      [{ space_id: 'space-other', key: 'OTHER-1' }],
      'space-active',
      { onlyPresentElsewhere: true },
    ),
  ).toEqual([selected[1]!])
})

test('foreign prune uses the strict hosted confirmation policy', () => {
  expect(() => confirmCount(1, undefined, 'exact-always')).toThrow('confirmation count 1')
  expect(() => confirmCount(1, 0, 'exact-always')).toThrow('confirmation count 1')
  expect(() => confirmCount(1, 1, 'exact-always')).not.toThrow()
})

test('foreign prune requires a space and addresses list, presence, and delete to it', async () => {
  await expect(pruneForeignHostedTasks({ dryRun: true })).rejects.toThrow('--space <id>')
  const requests: Array<{ path: string; space: string | null }> = []
  const fetch = async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    requests.push({ path, space: new Headers(init?.headers).get('x-record-space') })
    if (path === '/v1/tasks/identity')
      return Response.json({
        userId: 'user',
        activeSpaceId: 'space-active',
        memberships: [
          { spaceId: 'space-clean', slug: 'clean', permission: 'write' },
          { spaceId: 'space-workshop', slug: 'workshop', permission: 'write' },
        ],
      })
    if (path === '/v1/tasks') {
      if (init?.method === 'DELETE')
        return Response.json({ tasks: 1, comments: 0, documents: 0, statusEvents: 0 })
      return Response.json({
        tasks: [task('DEV-1', 'workshop')],
        comments: [],
        documents: [],
        statusEvents: [],
        cursor: 'done',
        more: false,
      })
    }
    if (path === '/v1/tasks/presence')
      return Response.json({
        present: [{ space_id: 'space-workshop', key: 'DEV-1' }],
        refused: [],
      })
    return Response.json({ error: 'unexpected' }, { status: 500 })
  }
  await pruneForeignHostedTasks({
    space: 'space-clean',
    confirmation: 1,
    baseUrl: 'https://hub.example.test',
    token: 'session',
    fetch,
  })
  expect(requests.filter((row) => row.path !== '/v1/tasks/identity')).toEqual([
    { path: '/v1/tasks', space: 'space-clean' },
    { path: '/v1/tasks/presence', space: 'space-clean' },
    { path: '/v1/tasks', space: 'space-clean' },
  ])
})
