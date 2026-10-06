import { expect, test } from 'bun:test'
import {
  activeFilterCount,
  applyFilters,
  chooserProject,
  clearStaleFilters,
  EMPTY_FILTERS,
  inAudience,
  inProject,
  offeredFilters,
  projectSubjects,
} from './filters.ts'
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

const docs: DocsTreeItem[] = [
  item({ id: '1', title: 'One', scope: 'project', delivery: 'demand', subject: 'atlas' }),
  item({ id: '2', title: 'Two', scope: 'canon', delivery: 'inject', subject: 'atlas' }),
  item({ id: '3', title: 'Three', scope: 'project', delivery: 'demand', subject: 'starship' }),
  item({
    id: '4',
    title: 'Four',
    scope: 'machine',
    delivery: 'demand',
    subject: null,
    audience: 'technical',
  }),
]

test('a filter is offered only when the documents in view hold two distinct values', () => {
  const both = offeredFilters(docs)
  expect(both.map((filter) => filter.key)).toEqual(['scope', 'delivery'])
  expect(both[0]!.options).toEqual([
    { value: 'canon', count: 1 },
    { value: 'machine', count: 1 },
    { value: 'project', count: 2 },
  ])
  expect(both[1]!.options).toEqual([
    { value: 'demand', count: 3 },
    { value: 'inject', count: 1 },
  ])
  expect(offeredFilters(inAudience(docs, 'technical')).map((filter) => filter.key)).toEqual([])
})

test('delivery is not offered when no document carries it', () => {
  const without = docs.map(({ delivery: _delivery, ...row }) => row)
  expect(offeredFilters(without).map((filter) => filter.key)).toEqual(['scope'])
})

test('a chosen value the documents in view no longer hold is cleared', () => {
  const chosen = { scope: 'canon', delivery: 'inject' }
  expect(clearStaleFilters(inProject(docs, 'starship'), chosen)).toEqual(EMPTY_FILTERS)
  expect(clearStaleFilters(docs, chosen)).toEqual(chosen)
})

test('applying filters keeps matching documents and counts active choices', () => {
  expect(applyFilters(docs, { scope: 'project', delivery: 'demand' }).map((row) => row.id)).toEqual(
    ['1', '3'],
  )
  expect(activeFilterCount({ scope: 'project', delivery: null })).toBe(1)
  expect(activeFilterCount(EMPTY_FILTERS)).toBe(0)
})

test('project chooser lists subjects that have documents', () => {
  expect(projectSubjects(docs)).toEqual(['atlas', 'starship'])
  expect(inProject(docs, 'atlas').map((row) => row.id)).toEqual(['1', '2'])
  expect(inProject(docs, 'all')).toHaveLength(docs.length)
})

test('opening a document chooses its subject, or All projects when it has none', () => {
  expect(chooserProject(docs[0]!, ['atlas', 'starship'])).toBe('atlas')
  expect(chooserProject(docs[3]!, ['atlas', 'starship'])).toBe('all')
})

test('with no document the chooser starts on the first subject, else All projects', () => {
  expect(chooserProject(null, ['atlas', 'starship'])).toBe('atlas')
  expect(chooserProject(null, [])).toBe('all')
})
