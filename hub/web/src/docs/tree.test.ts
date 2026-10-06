import { expect, test } from 'bun:test'
import { docScopeHasProjectSubject } from '../../../../shared/docs.ts'
import { applyFilters, EMPTY_FILTERS } from './filters.ts'
import {
  breadcrumb,
  buildDocTree,
  flattenTree,
  groupRootsBySubject,
  neighbors,
  parentEdgeCycles,
  treePath,
} from './tree.ts'
import type { DocsTreeItem } from './types.ts'

function item(partial: Partial<DocsTreeItem> & Pick<DocsTreeItem, 'id' | 'title'>): DocsTreeItem {
  const scope = partial.scope ?? 'project'
  const subject = partial.subject === undefined ? 'atlas' : partial.subject
  return {
    slug: partial.slug ?? partial.id,
    parentId: partial.parentId ?? null,
    position: partial.position ?? 0,
    updatedAt: '2026-10-06T00:00:00.000Z',
    audience: partial.audience ?? 'user',
    delivery: partial.delivery,
    ...partial,
    scope,
    subject,
    projectName:
      'projectName' in partial
        ? partial.projectName
        : subject && docScopeHasProjectSubject(scope)
          ? subject
          : undefined,
  }
}

test('siblings order by position then title, and a missing parent is a root', () => {
  const tree = buildDocTree([
    item({ id: 'b', title: 'Beta', position: 1, parentId: 'missing' }),
    item({ id: 'a', title: 'Alpha', position: 1 }),
    item({ id: 'c', title: 'Child', position: 0, parentId: 'a' }),
    item({ id: 'z', title: 'Zed', position: 0 }),
  ])
  expect(tree.map((node) => node.id)).toEqual(['z', 'a', 'b'])
  expect(tree[1]!.children.map((node) => node.id)).toEqual(['c'])
})

test('a document with children is present as a selectable node with those children', () => {
  const tree = buildDocTree([
    item({ id: 'parent', title: 'Parent' }),
    item({ id: 'kid', title: 'Kid', parentId: 'parent' }),
  ])
  expect(tree[0]!.id).toBe('parent')
  expect(tree[0]!.children[0]!.id).toBe('kid')
})

test('a parent edge that would cycle becomes a root and does not loop', () => {
  const a = item({ id: 'a', title: 'A', parentId: 'b' })
  const b = item({ id: 'b', title: 'B', parentId: 'a' })
  const byId = new Map([
    ['a', a],
    ['b', b],
  ])
  expect(parentEdgeCycles(a, byId)).toBe(true)
  expect(parentEdgeCycles(b, byId)).toBe(true)
  const tree = buildDocTree([a, b])
  expect(tree.map((node) => node.id).sort()).toEqual(['a', 'b'])
  expect(tree.every((node) => node.children.length === 0)).toBe(true)
})

test('a node pointing into a two-cycle stays a child of its parent', () => {
  const tree = buildDocTree([
    item({ id: 'root', title: 'Root', parentId: 'a' }),
    item({ id: 'a', title: 'A', parentId: 'b' }),
    item({ id: 'b', title: 'B', parentId: 'a' }),
  ])
  const ids = tree.map((node) => node.id).sort()
  expect(ids).toContain('a')
  expect(ids).toContain('b')
  const a = tree.find((node) => node.id === 'a')
  expect(a?.children.map((node) => node.id)).toEqual(['root'])
})

test('the tree path includes the document; the breadcrumb does not', () => {
  const child = item({ id: 'r', title: 'Your first run', parentId: 'g' })
  const tree = buildDocTree([item({ id: 'g', title: 'Getting started' }), child])
  const path = treePath(tree, 'r')
  expect(path.map((node) => node.title)).toEqual(['Getting started', 'Your first run'])
  expect(breadcrumb(child, path.slice(0, -1))).toEqual([
    { key: 'docs', label: 'Docs' },
    { key: 'project:atlas', label: 'atlas' },
    { key: 'g', label: 'Getting started' },
  ])
  expect(treePath(tree, 'missing')).toEqual([])
})

test('a document with no project omits the project from the breadcrumb', () => {
  const root = item({ id: 's', title: 'Shared note', subject: null })
  expect(breadcrumb(root, [])).toEqual([{ key: 'docs', label: 'Docs' }])
})

test('an agent subject is not a project group', () => {
  const tree = buildDocTree([
    item({ id: 'a', title: 'Agent', scope: 'agent', subject: 'writer' }),
    item({ id: 'p', title: 'Product', subject: 'atlas' }),
  ])
  expect(groupRootsBySubject(tree).map((group) => group.heading)).toEqual(['atlas', 'Shared'])
})

test('All projects groups roots by subject, Shared last, and does not regroup a single project', () => {
  const tree = buildDocTree([
    item({ id: 'z', title: 'Zed', subject: 'starship', position: 0 }),
    item({ id: 'a', title: 'Alpha', subject: 'atlas', position: 1 }),
    item({ id: 's', title: 'Shared note', subject: null, position: 2 }),
    item({ id: 'c', title: 'Child', parentId: 'a', subject: 'atlas' }),
  ])
  expect(groupRootsBySubject(tree).map((group) => group.heading)).toEqual([
    'atlas',
    'starship',
    'Shared',
  ])
  expect(groupRootsBySubject(tree)[0]!.children.map((node) => node.id)).toEqual(['a'])
  expect(groupRootsBySubject(tree)[0]!.children[0]!.children.map((node) => node.id)).toEqual(['c'])
})

test('previous and next follow preorder of the visible tree', () => {
  const tree = buildDocTree([
    item({ id: 'g', title: 'Getting started', position: 0 }),
    item({ id: 'install', title: 'Install', parentId: 'g', position: 0 }),
    item({ id: 'run', title: 'Your first run', parentId: 'g', position: 1 }),
    item({ id: 'how', title: 'How it works', position: 1 }),
  ])
  expect(neighbors(tree, 'run')).toEqual({
    previous: expect.objectContaining({ id: 'install' }),
    next: expect.objectContaining({ id: 'how' }),
  })
  expect(neighbors(tree, 'g').previous).toBeNull()
  expect(neighbors(tree, 'how').next).toBeNull()
  expect(flattenTree(tree).map((node) => node.id)).toEqual(['g', 'install', 'run', 'how'])
})

test('filters do not change neighbor order beyond the visible tree', () => {
  const items = [
    item({ id: 'a', title: 'A', scope: 'project' }),
    item({ id: 'b', title: 'B', scope: 'canon' }),
    item({ id: 'c', title: 'C', scope: 'project' }),
  ]
  const tree = buildDocTree(applyFilters(items, { ...EMPTY_FILTERS, scope: 'project' }))
  expect(neighbors(tree, 'a').next).toEqual(expect.objectContaining({ id: 'c' }))
})
