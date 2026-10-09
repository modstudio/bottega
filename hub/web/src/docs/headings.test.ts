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

test('fenced code is ignored and duplicate titles keep the same ids as the renderer', () => {
  const body = [
    '```',
    '## inside fence',
    '```',
    '~~~js',
    '## inside tildes',
    '~~~',
    '## Real',
    '## Real',
  ].join('\n')
  expect(secondLevelHeadings(body)).toEqual([
    { id: 'real', title: 'Real' },
    { id: 'real-2', title: 'Real' },
  ])
})

test('indented code is ignored', () => {
  expect(secondLevelHeadings('    ## indented\n\t## tabbed\n## Real\n')).toEqual([
    { id: 'real', title: 'Real' },
  ])
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
    audiences: ['user'],
    delivery: 'demand',
    status: 'draft',
    replacementSlug: null,
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
    audiences: ['user'],
    delivery: 'demand',
    status: 'draft',
    replacementSlug: null,
    summary: '',
    featured: false,
    projectName: 'atlas',
  })
  expect(mapDoc({ ...mapped, body: '# Hi' }).body).toBe('# Hi')
})

test('local, hosted and public records carry lifecycle fields through the shared mapper', () => {
  const local = mapTreeItem({
    id: 'local',
    slug: 'local',
    title: 'Local',
    audiences: ['technical'],
    status: 'superseded',
    replacementSlug: 'replacement',
  })
  const hosted = mapTreeItem({
    id: 'hosted',
    slug: 'hosted',
    title: 'Hosted',
    audiences: ['technical'],
    status: 'draft',
  })
  const published = mapTreeItem({
    id: 'public',
    slug: 'public',
    title: 'Public',
    audiences: ['user'],
  })
  expect([local.status, local.replacementSlug]).toEqual(['superseded', 'replacement'])
  expect([hosted.status, hosted.replacementSlug]).toEqual(['draft', null])
  expect([published.status, published.replacementSlug]).toEqual(['current', null])
})

test('hosted projectName is used as-is; local and public derive it from project scopes', () => {
  expect(
    mapTreeItem({
      id: '1',
      slug: 'agent',
      title: 'Agent',
      parentId: null,
      position: 0,
      updatedAt: '2026-10-06T00:00:00.000Z',
      scope: 'agent',
      subject: 'writer',
      audiences: ['technical'],
      projectName: null,
    }).projectName,
  ).toBeUndefined()
  expect(
    mapTreeItem({
      id: '2',
      slug: 'agent',
      title: 'Agent',
      parentId: null,
      position: 0,
      updatedAt: '2026-10-06T00:00:00.000Z',
      scope: 'agent',
      subject: 'writer',
      audiences: ['technical'],
    }).projectName,
  ).toBeUndefined()
  expect(
    mapTreeItem({
      id: '3',
      slug: 'first-run',
      title: 'Your first run',
      parentId: null,
      position: 0,
      updatedAt: '2026-10-06T00:00:00.000Z',
      scope: 'project',
      subject: 'atlas',
      audiences: ['user'],
    }).projectName,
  ).toBe('atlas')
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
    status: 'current',
    snippet: 'x',
    matchPosition: 0,
  })
})
