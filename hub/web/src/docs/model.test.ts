import { expect, test } from 'bun:test'
import { docScopeHasProjectSubject } from '../../../../shared/docs.ts'
import { EMPTY_FILTERS } from './filters.ts'
import { docsViewModel, docsVisibleByStatus, resolveDocsReplacement } from './model.ts'
import type { DocsTreeItem } from './types.ts'

function item(partial: Partial<DocsTreeItem> & Pick<DocsTreeItem, 'id' | 'title'>): DocsTreeItem {
  const scope = partial.scope ?? 'project'
  const subject = partial.subject === undefined ? 'atlas' : partial.subject
  return {
    slug: partial.id,
    parentId: null,
    position: 0,
    updatedAt: '2026-10-06T00:00:00.000Z',
    audiences: ['user'],
    ...partial,
    status: partial.status ?? 'current',
    replacementSlug: partial.replacementSlug ?? null,
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

const items = [
  item({ id: 'g', title: 'Getting started', position: 0 }),
  item({ id: 'r', title: 'Your first run', parentId: 'g', position: 0 }),
  item({ id: 's', title: 'Shared note', subject: null, position: 1 }),
  item({ id: 'z', title: 'Zed', subject: 'starship', position: 2 }),
]

test('tree visibility includes drafts only when asked and never includes retired documents', () => {
  const lifecycleItems = [
    item({ id: 'current', title: 'Current', status: 'current' }),
    item({ id: 'draft', title: 'Draft', status: 'draft' }),
    item({ id: 'superseded', title: 'Superseded', status: 'superseded' }),
    item({ id: 'archived', title: 'Archived', status: 'archived' }),
  ]
  expect(docsVisibleByStatus(lifecycleItems, false).map((row) => row.id)).toEqual(['current'])
  expect(docsVisibleByStatus(lifecycleItems, true).map((row) => row.id)).toEqual([
    'current',
    'draft',
  ])
})

test('replacement resolution requires one row at the same document address', () => {
  const retired = {
    ...item({ id: 'old', title: 'Old guide', status: 'superseded' }),
    replacementSlug: 'new-guide',
    body: 'Old body',
  }
  const replacement = item({ id: 'new', slug: 'new-guide', title: 'New guide' })
  expect(resolveDocsReplacement(retired, [replacement])).toBe(replacement)
  expect(
    resolveDocsReplacement(retired, [replacement, { ...replacement, id: 'duplicate' }]),
  ).toBeNull()
  expect(resolveDocsReplacement(retired, [{ ...replacement, subject: 'other' }])).toBeNull()
})

test('the breadcrumb is Docs, subject and ancestors, not the document title', () => {
  const model = docsViewModel(items, 'atlas', EMPTY_FILTERS, 'r', null)
  expect(model.crumbs.map((crumb) => crumb.label)).toEqual(['Docs', 'atlas', 'Getting started'])
})

test('All projects groups roots; a single project does not', () => {
  const all = docsViewModel(items, 'all', EMPTY_FILTERS, 'g', null)
  expect(all.groups?.map((group) => group.heading)).toEqual(['atlas', 'starship', 'Shared'])
  const one = docsViewModel(items, 'atlas', EMPTY_FILTERS, 'g', null)
  expect(one.groups).toBeNull()
})

test('a selected document outside the visible tree is not the displayed document', () => {
  const hidden = docsViewModel(items, 'atlas', { ...EMPTY_FILTERS, audience: 'technical' }, 'r', {
    ...items[1]!,
    body: '## Open\n',
  })
  expect(hidden.selected).toBeNull()
  expect(hidden.crumbs).toEqual([])
  expect(hidden.headings).toEqual([{ id: 'open', title: 'Open' }])
})

test('document counts follow the audience filter without counting retained ancestors', () => {
  const catalogue = [
    item({ id: 'parent', title: 'Parent', audiences: ['user'] }),
    item({
      id: 'child',
      title: 'Child',
      parentId: 'parent',
      audiences: ['technical'],
    }),
    item({ id: 'both', title: 'Both', audiences: ['user', 'technical'] }),
  ]
  expect(docsViewModel(catalogue, 'atlas', EMPTY_FILTERS, null, null).documentCount).toBe(3)
  const technical = docsViewModel(
    catalogue,
    'atlas',
    { ...EMPTY_FILTERS, audience: 'technical' },
    null,
    null,
  )
  expect(technical.documentCount).toBe(2)
  expect(technical.inView).toBe(3)
  expect(technical.tree.find((node) => node.id === 'parent')!.navigationDisabled).toBeTrue()
})
