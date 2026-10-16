import { expect, test } from 'bun:test'
import {
  fieldChangeReason,
  fieldWriteInput,
  parentChoices,
  subjectsExcept,
  withCurrentSubjects,
} from './doc-field-changes.ts'
import type { DocsDoc, DocsTreeItem } from './types.ts'

const doc: DocsDoc = {
  id: 'self',
  slug: 'article',
  title: 'Article',
  body: 'Stored body',
  parentId: null,
  position: 0,
  updatedAt: '2026-10-14T12:00:00Z',
  scope: 'project',
  subject: 'workshop',
  projectName: 'workshop',
  audiences: ['internal'],
  status: 'draft',
  kind: 'article',
  summarySource: 'derived',
  replacementSlug: null,
}

function item(id: string, parentId: string | null, overrides: Partial<DocsTreeItem> = {}) {
  return {
    ...doc,
    body: undefined,
    id,
    slug: id,
    title: id,
    parentId,
    ...overrides,
  } as DocsTreeItem
}

test('parent choices exclude self, descendants, and documents outside the project scope', () => {
  const root = item('root', null)
  const child = item('child', 'self')
  const grandchild = item('grandchild', 'child')
  const otherProject = item('other-project', null, {
    projectName: 'Elsewhere',
    subject: 'Elsewhere',
  })
  const otherScope = item('other-scope', null, { scope: 'global' })

  expect(
    parentChoices(doc, [root, item('self', null), child, grandchild, otherProject, otherScope]),
  ).toEqual([root])
})

test('field reasons spell out the resulting value', () => {
  expect(fieldChangeReason({ field: 'status', value: 'current' })).toBe('Status set to Current')
  expect(fieldChangeReason({ field: 'parent', value: null })).toBe('Moved to top level')
  expect(fieldChangeReason({ field: 'audiences', value: ['technical', 'internal'] })).toBe(
    'Audience set to Internal, Technical',
  )
  expect(fieldChangeReason({ field: 'form', value: null })).toBe('Type cleared')
  expect(
    fieldChangeReason({
      field: 'relatedSubjects',
      value: [
        { id: 'pricing', name: 'Pricing' },
        { id: 'inventory', name: 'Inventory' },
      ],
    }),
  ).toBe('Related subjects set to Inventory, Pricing')
  expect(fieldChangeReason({ field: 'relatedSubjects', value: [] })).toBe(
    'Related subjects cleared',
  )
  expect(
    fieldChangeReason({
      field: 'sourceFiles',
      value: ['hub/a.ts'],
      action: 'added',
      path: 'hub/a.ts',
    }),
  ).toBe('Source file added: hub/a.ts')
})

test('article subject choices exclude related subjects', () => {
  expect(
    subjectsExcept(
      [
        { id: 'pricing', name: 'Pricing' },
        { id: 'inventory', name: 'Inventory' },
      ],
      [{ id: 'pricing', name: 'Pricing' }],
    ),
  ).toEqual([{ id: 'inventory', name: 'Inventory' }])
})

test('local writes use stored text, slugs, and subject names', () => {
  expect(
    fieldWriteInput(
      'local',
      { ...doc, body: 'Audience-filtered body' },
      {
        title: 'Stored title',
        body: 'Stored body',
        revision: 'revision-1',
      },
      {
        field: 'articleSubject',
        value: { id: 'subject-id', name: 'Pricing' },
      },
    ),
  ).toEqual({
    scope: 'project',
    subject: 'workshop',
    slug: 'article',
    title: 'Stored title',
    body: 'Stored body',
    reason: 'Subject set to Pricing',
    expectedRevision: 'revision-1',
    articleSubject: 'Pricing',
  })
})

test('summary writes use the existing field-save input for local and hosted docs', () => {
  const change = { field: 'summary', value: 'A written summary' } as const
  expect(
    fieldWriteInput(
      'local',
      doc,
      { title: 'Article', body: 'Stored body', revision: 'revision-1' },
      change,
    ),
  ).toMatchObject({ summary: 'A written summary', reason: 'Summary updated' })
  expect(
    fieldWriteInput(
      'hosted',
      { ...doc, spaceId: 'space-id' },
      { title: 'Article', body: 'Stored body', revision: 'revision-2' },
      { field: 'summary', value: null },
    ),
  ).toMatchObject({ summary: null, reason: 'Summary cleared' })
})

test('hosted writes use record ids and send only the changed optional field', () => {
  expect(
    fieldWriteInput(
      'hosted',
      { ...doc, spaceId: 'space-id' },
      { title: 'Article', body: 'Stored body', revision: 'revision-2' },
      {
        field: 'parent',
        value: item('parent-id', null, { slug: 'parent-slug', title: 'Product pricing' }),
      },
    ),
  ).toEqual({
    spaceId: 'space-id',
    scope: 'project',
    subject: 'workshop',
    slug: 'article',
    title: 'Article',
    body: 'Stored body',
    reason: 'Parent set to Product pricing',
    expectedRevision: 'revision-2',
    parentRecordId: 'parent-id',
  })
})

test('a subject the article carries but the catalog does not list stays choosable', () => {
  const catalog = [{ id: 'pricing', name: 'Pricing' }]
  const retired = { id: 'stock', name: 'Stock' }
  expect(withCurrentSubjects(catalog, [retired, { id: 'pricing', name: 'Pricing' }])).toEqual([
    { id: 'pricing', name: 'Pricing' },
    retired,
  ])
})
