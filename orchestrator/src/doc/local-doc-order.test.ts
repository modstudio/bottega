import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { DocAudience } from '../../../shared/docs.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { setDoc } from '../../test/fixtures/docs.ts'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { REFERENCE_GENERATOR } from './doc-generator.ts'
import { reorderDocs } from './docs.ts'

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
    reorderDocs({
      scope: 'global',
      subject: null,
      parentId: parent.record_id,
      orderedIds: [first.record_id],
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
    .query<{ record_id: string; updated_at: string }, [string, string]>(
      'SELECT record_id, updated_at FROM doc WHERE record_id IN (?, ?) ORDER BY record_id',
    )
    .all(first.record_id, second.record_id)
  const revisionsBefore = db()
    .query<{ count: number }, [string, string]>(
      'SELECT count(*) AS count FROM doc_revision WHERE doc_record_id IN (?, ?)',
    )
    .get(first.record_id, second.record_id)!.count

  await reorderDocs({
    scope: 'global',
    subject: null,
    parentId: parent.record_id,
    orderedIds: [second.record_id, first.record_id],
  })

  expect(
    db()
      .query<{ record_id: string }, [string]>(
        'SELECT record_id FROM doc WHERE parent_record_id=? ORDER BY position',
      )
      .all(parent.record_id)
      .map((row) => row.record_id),
  ).toEqual([second.record_id, first.record_id])
  expect(
    db()
      .query<{ record_id: string; updated_at: string }, [string, string]>(
        'SELECT record_id, updated_at FROM doc WHERE record_id IN (?, ?) ORDER BY record_id',
      )
      .all(first.record_id, second.record_id),
  ).toEqual(before)
  expect(
    db()
      .query<{ count: number }, [string, string]>(
        'SELECT count(*) AS count FROM doc_revision WHERE doc_record_id IN (?, ?)',
      )
      .get(first.record_id, second.record_id)!.count,
  ).toBe(revisionsBefore)
})

test('reorder refuses the children of a generated reference page', async () => {
  upsertProject({ recordId: newRecordId(), name: PLATFORM_SLUG, path: process.cwd(), settings: {} })
  const page = {
    kind: 'article' as const,
    delivery: 'demand' as const,
    audiences: ['technical'] as [DocAudience],
    form: 'reference' as const,
    generator: REFERENCE_GENERATOR,
  }
  const parent = await setDoc({
    scope: 'project',
    subject: PLATFORM_SLUG,
    slug: 'cli',
    title: 'CLI',
    body: 'Index',
    ...page,
  })
  const first = await setDoc({
    scope: 'project',
    subject: PLATFORM_SLUG,
    slug: 'cli-run',
    title: 'run',
    body: 'Run',
    parentSlug: parent.slug,
    ...page,
  })
  const second = await setDoc({
    scope: 'project',
    subject: PLATFORM_SLUG,
    slug: 'cli-doc',
    title: 'doc',
    body: 'Doc',
    parentSlug: parent.slug,
    ...page,
  })

  await expect(
    reorderDocs({
      scope: 'project',
      subject: PLATFORM_SLUG,
      parentId: parent.record_id,
      orderedIds: [second.record_id, first.record_id],
    }),
  ).rejects.toThrow(`cleared by: ${PLATFORM_SLUG} doc reference publish`)
})
