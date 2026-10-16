import { expect, test } from 'bun:test'
import { highlightSnippet, mapDoc, mapSearchMatch, mapTreeItem } from './map.ts'

const article = {
  form: 'overview' as const,
  articleSubject: { id: 'subject-1', name: 'Routing' },
  relatedSubjects: [
    { id: 'subject-2', name: 'Evidence' },
    { id: 'subject-3', name: 'Review' },
  ],
  sourceFiles: ['orchestrator/src/route.ts', 'orchestrator/src/evidence.ts'],
  checkedAgainstCommit: '1111111111111111111111111111111111111111',
}

const articleRow = {
  id: 1,
  slug: 'routing',
  title: 'Routing',
  parentId: null,
  position: 0,
  updatedAt: '2026-10-11T00:00:00.000Z',
  scope: 'project',
  subject: 'starship',
  audiences: ['technical'],
  status: 'current',
  kind: 'article',
  replacementSlug: null,
  body: 'Body.',
  ...article,
}

test('the mapping carries article fields', () => {
  const mapped = mapDoc(articleRow)
  expect(mapped.form).toBe(article.form)
  expect(mapped.articleSubject).toEqual(article.articleSubject)
  expect(mapped.relatedSubjects).toEqual(article.relatedSubjects)
  expect(mapped.sourceFiles).toEqual(article.sourceFiles)
  expect(mapped.checkedAgainstCommit).toBe(article.checkedAgainstCommit)
})

test('record-shaped docs map onto the shared tree item and keep delivery', () => {
  const mapped = mapTreeItem({
    id: '00000000-0000-4000-8000-000000000001',
    spaceId: '00000000-0000-4000-8000-000000000002',
    slug: 'first-run',
    title: 'Your first run',
    parentId: null,
    position: 2,
    updatedAt: '2026-10-06T00:00:00.000Z',
    scope: 'project',
    subject: 'atlas',
    audiences: ['internal'],
    delivery: 'demand',
    status: 'draft',
    kind: 'working',
    form: 'how-to',
    summarySource: 'derived',
    replacementSlug: null,
    spaceName: 'Workshop',
    body: 'hello',
  })
  expect(mapped).toEqual({
    id: '00000000-0000-4000-8000-000000000001',
    spaceId: '00000000-0000-4000-8000-000000000002',
    slug: 'first-run',
    title: 'Your first run',
    parentId: null,
    position: 2,
    updatedAt: '2026-10-06T00:00:00.000Z',
    scope: 'project',
    subject: 'atlas',
    audiences: ['internal'],
    delivery: 'demand',
    status: 'draft',
    kind: 'working',
    form: 'how-to',
    replacementSlug: null,
    summary: '',
    summarySource: 'derived',
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
    kind: 'article',
    status: 'superseded',
    replacementSlug: 'replacement',
  })
  const hosted = mapTreeItem({
    id: 'hosted',
    slug: 'hosted',
    title: 'Hosted',
    audiences: ['technical'],
    status: 'draft',
    kind: 'article',
  })
  const published = mapTreeItem({
    id: 'public',
    slug: 'public',
    title: 'Public',
    audiences: ['internal'],
    kind: 'article',
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
      kind: 'working',
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
      kind: 'working',
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
      audiences: ['internal'],
      kind: 'article',
    }).projectName,
  ).toBe('atlas')
})

test('search highlight wraps each range and maps hosted highlights', () => {
  expect(
    highlightSnippet({
      snippet: 'the worktree is disposable',
      highlights: [{ start: 4, length: 8 }],
    }),
  ).toEqual([
    { text: 'the ', highlight: false, start: 0 },
    { text: 'worktree', highlight: true, start: 4 },
    { text: ' is disposable', highlight: false, start: 12 },
  ])
  expect(highlightSnippet({ snippet: 'plain text', highlights: [] })).toEqual([
    { text: 'plain text', highlight: false, start: 0 },
  ])
  expect(
    mapSearchMatch({
      id: '1',
      slug: 'a',
      title: 'A',
      audiences: ['internal'],
      kind: 'article',
      snippet: 'x',
      summary: 'Summary',
      summarySource: 'written',
      highlights: [{ start: 0, length: 1 }],
    }),
  ).toEqual({
    id: '1',
    slug: 'a',
    title: 'A',
    audiences: ['internal'],
    status: 'current',
    kind: 'article',
    snippet: 'x',
    summary: 'Summary',
    summarySource: 'written',
    highlights: [{ start: 0, length: 1 }],
  })
})
