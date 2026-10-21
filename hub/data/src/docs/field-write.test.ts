import { expect, test } from 'bun:test'
import { fieldWriteInput } from './field-write.ts'

const doc = {
  id: 'self',
  slug: 'article',
  title: 'Article',
  body: 'Stored body',
  parentId: null,
  scope: 'project',
  subject: 'workshop',
}

test('local field writes use stored text, slugs, and subject names', () => {
  expect(
    fieldWriteInput(
      'local',
      doc,
      { title: 'Stored title', body: 'Stored body', revision: 'revision-1' },
      { field: 'articleSubject', value: { id: 'subject-id', name: 'Pricing' } },
      'Subject set to Pricing',
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

test('field writes adapt shared changes to the selected data source', () => {
  const change = { field: 'summary', value: 'A written summary' } as const
  expect(
    fieldWriteInput(
      'local',
      doc,
      { title: 'Article', body: 'Stored body', revision: 'revision-1' },
      change,
      'Summary updated',
    ),
  ).toMatchObject({ summary: 'A written summary', reason: 'Summary updated' })
  expect(
    fieldWriteInput(
      'hosted',
      { ...doc, spaceId: 'space-id' },
      { title: 'Article', body: 'Stored body', revision: 'revision-2' },
      { field: 'summary', value: null },
      'Summary cleared',
    ),
  ).toMatchObject({ summary: null, reason: 'Summary cleared' })
})

test('hosted field writes use record ids and send only the changed optional field', () => {
  expect(
    fieldWriteInput(
      'hosted',
      { ...doc, spaceId: 'space-id' },
      { title: 'Article', body: 'Stored body', revision: 'revision-2' },
      {
        field: 'parent',
        value: { ...doc, id: 'parent-id', slug: 'parent-slug', title: 'Product pricing' },
      },
      'Parent set to Product pricing',
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
