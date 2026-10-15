import { expect, test } from 'bun:test'
import { setDoc } from '../../test/fixtures/docs.ts'
import { db } from '../database/db.ts'
import { reorderLocalDocs } from './local-doc-order.ts'

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

  expect(() =>
    reorderLocalDocs({
      scope: 'global',
      subject: null,
      parentId: String(parent.id),
      orderedIds: [String(first.id)],
    }),
  ).toThrow('missing ids')
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

  reorderLocalDocs({
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
})
