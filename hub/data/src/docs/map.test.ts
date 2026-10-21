import { expect, test } from 'bun:test'
import { mapDoc, mapSearchMatch, mapTreeItem } from './map.ts'

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

test('record-shaped docs map onto the view model and keep delivery', () => {
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

test('source lifecycle defaults and project names are normalized', () => {
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
  expect(
    mapTreeItem({
      id: 'project',
      slug: 'first-run',
      title: 'Your first run',
      scope: 'project',
      subject: 'atlas',
      audiences: ['internal'],
      kind: 'article',
    }).projectName,
  ).toBe('atlas')
  expect(
    mapTreeItem({
      id: 'hosted-project',
      slug: 'first-run',
      title: 'Your first run',
      scope: 'project',
      subject: 'atlas',
      audiences: ['internal'],
      kind: 'article',
      projectName: null,
    }).projectName,
  ).toBeUndefined()
})

test('invalid source shapes are rejected or omitted', () => {
  expect(() => mapTreeItem({ id: '1', kind: 'article', audiences: 'internal' })).toThrow(
    'document audiences must be an array',
  )
  expect(() => mapTreeItem({ id: '1', audiences: ['internal'], kind: 'unknown' })).toThrow(
    'document kind is required',
  )
  expect(
    mapDoc({
      id: '1',
      audiences: ['internal'],
      kind: 'article',
      sourceFiles: ['valid.ts', 2],
      articleSubject: { id: 2, name: 'Invalid' },
      relatedSubjects: [{ id: 'one', name: 'One' }, { id: 2 }],
    }),
  ).toMatchObject({
    sourceFiles: ['valid.ts'],
    articleSubject: undefined,
    relatedSubjects: undefined,
  })
})

test('search records normalize highlights and defaults', () => {
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
      highlights: [{ start: 0, length: 1 }, { start: -1, length: 2 }, null],
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
