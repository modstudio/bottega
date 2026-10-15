import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import { db } from '../database/db.ts'
import { reorderLocalDocs } from './docs.ts'
import { hostedDocOrder } from './local-doc-order.ts'

test('reorder refuses an id list that is not the complete current sibling set', async () => {
  const parent = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'parent',
    title: 'Parent',
    body: 'Parent',
  })
  const first = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'first',
    title: 'First',
    body: 'First',
    parentSlug: parent.slug,
    kind: 'article',
    delivery: 'demand',
    audiences: ['technical'],
  })
  await setDoc({
    scope: 'global',
    subject: null,
    slug: 'second',
    title: 'Second',
    body: 'Second',
    parentSlug: parent.slug,
    kind: 'article',
    delivery: 'demand',
    audiences: ['technical'],
  })

  await expect(
    reorderLocalDocs({
      scope: 'global',
      subject: null,
      parentId: String(parent.id),
      orderedIds: [String(first.id)],
    }),
  ).rejects.toThrow('missing ids')
})

test('reorder changes only live positions', async () => {
  const parent = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'layout',
    title: 'Layout',
    body: 'Parent',
  })
  const first = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'alpha',
    title: 'Alpha',
    body: 'Alpha',
    parentSlug: parent.slug,
    kind: 'article',
    delivery: 'demand',
    audiences: ['technical'],
  })
  const second = await setDoc({
    scope: 'global',
    subject: null,
    slug: 'beta',
    title: 'Beta',
    body: 'Beta',
    parentSlug: parent.slug,
    kind: 'article',
    delivery: 'demand',
    audiences: ['technical'],
  })
  const before = db()
    .query<{ id: number; updated_at: string }, [number, number]>(
      'SELECT id, updated_at FROM doc WHERE id IN (?, ?) ORDER BY id',
    )
    .all(first.id, second.id)
  const revisionsBefore = db()
    .query<{ count: number }, [number, number]>(
      'SELECT count(*) AS count FROM doc_revision WHERE doc_id IN (?, ?)',
    )
    .get(first.id, second.id)!.count

  await reorderLocalDocs({
    scope: 'global',
    subject: null,
    parentId: String(parent.id),
    orderedIds: [String(second.id), String(first.id)],
  })

  expect(
    db()
      .query<{ id: number }, [number]>('SELECT id FROM doc WHERE parent_id=? ORDER BY position')
      .all(parent.id)
      .map((row) => row.id),
  ).toEqual([second.id, first.id])
  expect(
    db()
      .query<{ id: number; updated_at: string }, [number, number]>(
        'SELECT id, updated_at FROM doc WHERE id IN (?, ?) ORDER BY id',
      )
      .all(first.id, second.id),
  ).toEqual(before)
  expect(
    db()
      .query<{ count: number }, [number, number]>(
        'SELECT count(*) AS count FROM doc_revision WHERE doc_id IN (?, ?)',
      )
      .get(first.id, second.id)!.count,
  ).toBe(revisionsBefore)
})

test('hosted order translates local ids and names a document without a record id', () => {
  const input = {
    scope: 'global',
    subject: null,
    parentId: '10',
    orderedIds: ['12', '11'],
  }
  const parent = { id: 10, slug: 'parent', record_id: 'record-parent' }
  expect(
    hostedDocOrder(
      input,
      [
        { id: 11, slug: 'first', record_id: 'record-first' },
        { id: 12, slug: 'second', record_id: 'record-second' },
      ],
      parent,
      `run ${PLATFORM_SLUG} record push-docs before reordering documents`,
    ),
  ).toEqual({
    ...input,
    parentId: 'record-parent',
    orderedIds: ['record-second', 'record-first'],
  })
  expect(() =>
    hostedDocOrder(
      input,
      [
        { id: 11, slug: 'first', record_id: null },
        { id: 12, slug: 'second', record_id: 'record-second' },
      ],
      parent,
      `run ${PLATFORM_SLUG} record push-docs before reordering documents`,
    ),
  ).toThrow(
    `document "first" has no hosted record id; cleared by: run ${PLATFORM_SLUG} record push-docs`,
  )
})
