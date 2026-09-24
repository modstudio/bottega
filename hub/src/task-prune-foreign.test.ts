import { expect, test } from 'bun:test'
import type { HostedTask } from './hosted-tasks.ts'
import { confirmSoftDelete } from './hosted-tasks.ts'
import { confirmForeignTaskPrune, selectForeignHostedTasks } from './task-prune-foreign.ts'

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
})

const identity = {
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

test('foreign prune requires its exact count and the hosted bulk gate still guards multiple rows', () => {
  expect(() => confirmForeignTaskPrune(1)).toThrow('--confirm 1')
  expect(() => confirmForeignTaskPrune(1, 0)).toThrow('--confirm 1')
  expect(() => confirmForeignTaskPrune(1, 1)).not.toThrow()
  expect(() => confirmSoftDelete(2, 1)).toThrow('confirmation count 2')
  expect(() => confirmSoftDelete(2, 2)).not.toThrow()
})
