import { expect, test } from 'bun:test'
import { headingId, secondLevelHeadings } from './headings.ts'
import { highlightSnippet, mapDoc, mapSearchMatch, mapTreeItem } from './map.ts'

test('second-level headings become contents entries with stable ids', () => {
  const body = `# Title\n\n## Open a task\n\ntext\n### Nested\n## Dispatch\n## Open a task\n`
  expect(secondLevelHeadings(body)).toEqual([
    { id: 'open-a-task', title: 'Open a task' },
    { id: 'dispatch', title: 'Dispatch' },
    { id: 'open-a-task-2', title: 'Open a task' },
  ])
  expect(headingId('On this page')).toBe('on-this-page')
})

test('record-shaped docs map onto the shared tree item and keep delivery', () => {
  const mapped = mapTreeItem({
    id: '00000000-0000-4000-8000-000000000001',
    slug: 'first-run',
    title: 'Your first run',
    parentId: null,
    position: 2,
    updatedAt: '2026-10-06T00:00:00.000Z',
    scope: 'project',
    subject: 'atlas',
    audience: 'user',
    delivery: 'demand',
    spaceName: 'Workshop',
    body: 'hello',
  })
  expect(mapped).toEqual({
    id: '00000000-0000-4000-8000-000000000001',
    slug: 'first-run',
    title: 'Your first run',
    parentId: null,
    position: 2,
    updatedAt: '2026-10-06T00:00:00.000Z',
    scope: 'project',
    subject: 'atlas',
    audience: 'user',
    delivery: 'demand',
  })
  expect(mapDoc({ ...mapped, body: '# Hi' }).body).toBe('# Hi')
})

test('search highlight uses matchPosition when it falls inside the snippet', () => {
  expect(highlightSnippet('the worktree is disposable', 4, 'worktree')).toEqual({
    before: 'the ',
    match: 'worktree',
    after: ' is disposable',
  })
  expect(
    mapSearchMatch({ id: '1', slug: 'a', title: 'A', snippet: 'x', matchPosition: 0 }),
  ).toEqual({
    id: '1',
    slug: 'a',
    title: 'A',
    snippet: 'x',
    matchPosition: 0,
  })
})
