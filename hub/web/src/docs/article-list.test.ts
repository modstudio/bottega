import { expect, test } from 'bun:test'
import { articleListRows } from './article-list.tsx'
import { docsVisibleByStatus } from './model.ts'
import { treeForAudience } from './tree.ts'
import type { DocsTreeItem } from './types.ts'

function item(
  id: string,
  title: string,
  parentId: string | null,
  position: number,
  extra: Partial<DocsTreeItem> = {},
): DocsTreeItem {
  return {
    id,
    slug: id,
    title,
    parentId,
    position,
    updatedAt: '2026-10-15T00:00:00Z',
    scope: 'project',
    subject: 'starship',
    audiences: ['technical'],
    status: 'current',
    kind: 'article',
    replacementSlug: null,
    summary: `${title} summary`,
    summarySource: 'written',
    ...extra,
  }
}

const items = [
  item('root', 'Product', null, 0),
  item('later', 'Later', 'root', 2, { form: 'reference' }),
  item('first', 'First', 'root', 1, { form: 'overview' }),
  item('alpha', 'Alpha tie', 'root', 2),
  item('grand', 'Grandchild', 'first', 0, { form: 'how-to' }),
  item('deep', 'Too deep', 'grand', 0),
  item('working', 'Working', 'root', 3, { kind: 'working' }),
  item('draft', 'Draft', 'root', 4, { status: 'draft' }),
  item('internal', 'Internal', 'root', 5, { audiences: ['internal'] }),
]

test('rows follow tree order for two levels and keep only visible articles', () => {
  const tree = treeForAudience(docsVisibleByStatus(items, false), 'technical')
  expect(
    articleListRows(tree, 'root').map(({ item: row, depth }) => [row.id, depth, row.form]),
  ).toEqual([
    ['first', 0, 'overview'],
    ['grand', 1, 'how-to'],
    ['alpha', 0, undefined],
    ['later', 0, 'reference'],
  ])
})

test('draft rows appear only in a tree that is showing drafts', () => {
  const current = treeForAudience(docsVisibleByStatus(items, false), 'technical')
  const withDrafts = treeForAudience(docsVisibleByStatus(items, true), 'technical')
  expect(articleListRows(current, 'root').some(({ item: row }) => row.id === 'draft')).toBeFalse()
  expect(articleListRows(withDrafts, 'root').some(({ item: row }) => row.id === 'draft')).toBeTrue()
})

test('a document with no visible article children has no rows', () => {
  expect(articleListRows(treeForAudience([items[0]!], 'technical'), 'root')).toEqual([])
  expect(articleListRows(treeForAudience(items, 'customer'), 'root')).toEqual([])
})
