import { expect, test } from 'bun:test'
import { selectTaskPushRows } from './task-push.ts'

test('task push selects active-space projects and reports every skipped project and reason', () => {
  const task = (key: string, project_name: string) => ({
    key,
    project: project_name,
    project_name,
    source: 'mcp',
  })
  const child = (task_key: string, project_name: string) => ({ task_key, project_name })
  const input = {
    tasks: [
      task('DEF-1', 'defaulted'),
      task('SLUG-1', 'by-slug'),
      task('ID-1', 'by-id'),
      task('OTHER-1', 'other'),
      task('LOST-1', 'unknown-space'),
      task('ORPHAN-1', 'unregistered'),
    ],
    comments: [child('OTHER-1', 'other')],
    documents: [child('LOST-1', 'unknown-space')],
    statusEvents: [child('SLUG-1', 'by-slug')],
  }
  const result = selectTaskPushRows(
    input,
    [
      { name: 'defaulted', settings: {} },
      { name: 'by-slug', settings: { space: 'active' } },
      { name: 'by-id', settings: { space: 'space-a' } },
      { name: 'other', settings: { space: 'other' } },
      { name: 'unknown-space', settings: { space: 'missing' } },
    ],
    {
      activeSpaceId: 'space-a',
      memberships: [
        { spaceId: 'space-a', slug: 'active' },
        { spaceId: 'space-b', slug: 'other' },
      ],
    },
  )

  expect(result.rows.tasks.map((row) => row.key)).toEqual(['DEF-1', 'SLUG-1', 'ID-1'])
  expect(result.rows.statusEvents).toHaveLength(1)
  expect(result.skipped).toEqual([
    {
      project: 'other',
      reason: 'different-space',
      tasks: 1,
      comments: 1,
      documents: 0,
      statusEvents: 0,
    },
    {
      project: 'unknown-space',
      reason: 'unmapped',
      tasks: 1,
      comments: 0,
      documents: 1,
      statusEvents: 0,
    },
    {
      project: 'unregistered',
      reason: 'unmapped',
      tasks: 1,
      comments: 0,
      documents: 0,
      statusEvents: 0,
    },
  ])
})
