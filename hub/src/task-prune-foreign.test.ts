import { expect, test } from 'bun:test'
import type { HostedTask } from './hosted-tasks.ts'
import { confirmCount } from './hosted-tasks.ts'
import { selectForeignHostedTasks } from './task-prune-foreign.ts'

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
    { spaceId: 'space-active', slug: 'active' },
    { spaceId: 'space-other', slug: 'other' },
  ],
}

test('foreign task selection shares push space rules and reports own-space presence', () => {
  const tasks = [
    task('DEF-1', 'defaulted'),
    task('HERE-1', 'here'),
    task('OTHER-1', 'other'),
    task('MISSING-1', 'other', 'git'),
    task('LOST-1', 'unknown-space'),
    task('ORPHAN-1', 'unregistered'),
  ]
  const registered = [
    { name: 'defaulted', settings: {} },
    { name: 'here', settings: { space: 'active' } },
    { name: 'other', settings: { space: 'other' } },
    { name: 'unknown-space', settings: { space: 'not-a-membership' } },
  ]
  const selected = selectForeignHostedTasks(tasks, registered, identity, [
    { space_id: 'space-other', key: 'OTHER-1' },
  ])

  expect(selected).toEqual([
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
      source: 'git',
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
      { onlyPresentElsewhere: true },
    ),
  ).toEqual([selected[0]!])
})

test('foreign prune uses the strict hosted confirmation policy', () => {
  expect(() => confirmCount(1, undefined, 'exact-always')).toThrow('confirmation count 1')
  expect(() => confirmCount(1, 0, 'exact-always')).toThrow('confirmation count 1')
  expect(() => confirmCount(1, 1, 'exact-always')).not.toThrow()
})
