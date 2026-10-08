import { expect, test } from 'bun:test'
import { docsHomeModel, FEATURED_GUIDE_LIMIT } from './home.tsx'
import type { DocsTreeItem } from './types.ts'

const item = (id: string, title: string, extra: Partial<DocsTreeItem> = {}): DocsTreeItem => ({
  id,
  title,
  slug: id,
  parentId: null,
  position: 0,
  updatedAt: '',
  scope: 'global',
  subject: null,
  audience: 'user',
  summary: `${title} summary`,
  featured: false,
  ...extra,
  status: extra.status ?? 'current',
  replacementSlug: extra.replacementSlug ?? null,
})

test('home decision orders and caps featured guides and lists top-level topics with their counts', () => {
  const parent = item('parent', 'Parent')
  const child = item('child', 'Child', { parentId: 'parent', featured: true })
  const more = item('more', 'More doc', { position: 2, featured: true })
  const extras = Array.from({ length: FEATURED_GUIDE_LIMIT }, (_, index) =>
    item(`x${index}`, `X${index}`, { position: index + 3, featured: true }),
  )
  const model = docsHomeModel([more, child, parent, ...extras])
  expect(model.featured).toHaveLength(FEATURED_GUIDE_LIMIT)
  expect(model.featured.slice(0, 2).map((row) => row.id)).toEqual(['child', 'more'])
  expect(model.topics.slice(0, 2).map((topic) => [topic.doc.title, topic.count])).toEqual([
    ['Parent', 1],
    ['More doc', 0],
  ])
  expect(docsHomeModel([])).toEqual({ featured: [], topics: [] })
})
