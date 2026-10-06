import { expect, test } from 'bun:test'
import { EMPTY_FILTERS } from './filters.ts'
import { docsViewModel } from './model.ts'
import type { DocsTreeItem } from './types.ts'

function item(partial: Partial<DocsTreeItem> & Pick<DocsTreeItem, 'id' | 'title'>): DocsTreeItem {
  return {
    slug: partial.id,
    parentId: null,
    position: 0,
    updatedAt: '2026-10-06T00:00:00.000Z',
    scope: 'project',
    subject: 'atlas',
    audience: 'user',
    ...partial,
  }
}

const items = [
  item({ id: 'g', title: 'Getting started', position: 0 }),
  item({ id: 'r', title: 'Your first run', parentId: 'g', position: 0 }),
  item({ id: 's', title: 'Shared note', subject: null, position: 1 }),
  item({ id: 'z', title: 'Zed', subject: 'starship', position: 2 }),
]

test('the breadcrumb is Docs, subject and ancestors, not the document title', () => {
  const model = docsViewModel(items, 'user', 'atlas', EMPTY_FILTERS, 'r', null)
  expect(model.crumbs.map((crumb) => crumb.label)).toEqual(['Docs', 'atlas', 'Getting started'])
})

test('All projects groups roots; a single project does not', () => {
  const all = docsViewModel(items, 'user', 'all', EMPTY_FILTERS, 'g', null)
  expect(all.groups?.map((group) => group.heading)).toEqual(['atlas', 'starship', 'Shared'])
  const one = docsViewModel(items, 'user', 'atlas', EMPTY_FILTERS, 'g', null)
  expect(one.groups).toBeNull()
})
