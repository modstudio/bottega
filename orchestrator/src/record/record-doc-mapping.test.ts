import { expect, test } from 'bun:test'
import { PLATFORM_NAME } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  importedLiveArticleFields,
  normalizeRecordDocImport,
  recordDocRevisionRow,
  recordDocRow,
} from './record-doc-mapping.ts'

test('an older import keeps populated live article fields and defaults revision snapshots', () => {
  const normalized = normalizeRecordDocImport(
    {
      doc: {
        scope: 'project',
        subject: PLATFORM_NAME,
        slug: 'article',
        title: 'Article',
        body: 'Current.',
        delivery: 'demand',
        kind: 'article',
        createdAt: '2026-10-11T00:00:00.000Z',
        updatedAt: '2026-10-11T00:00:00.000Z',
        deletedAt: null,
      },
      revisions: [
        {
          scope: 'project',
          subject: PLATFORM_NAME,
          slug: 'article',
          op: 'create',
          title: 'Article',
          body: 'Earlier.',
          delivery: 'demand',
          author: 'old-client',
          reason: 'import old snapshot',
          at: '2026-10-10T00:00:00.000Z',
        },
      ],
    },
    newRecordId(),
  )
  expect(
    importedLiveArticleFields(
      normalized.doc,
      {
        form: 'feature',
        article_subject_id: 'own',
        source_files: ['src/article.ts'],
      },
      ['related'],
    ),
  ).toEqual({
    form: 'feature',
    articleSubjectId: 'own',
    relatedSubjectIds: ['related'],
    sourceFiles: ['src/article.ts'],
    checkedAgainstCommit: null,
    summary: null,
  })
  expect(normalized.revisions[0]).toMatchObject({
    form: null,
    articleSubjectId: null,
    relatedSubjectIds: [],
    sourceFiles: [],
    checkedAgainstCommit: null,
  })
})

test('document row timestamps keep milliseconds when the driver returns Dates', () => {
  const timestamp = new Date('2026-10-09T12:34:56.789Z')
  const mapped = recordDocRow({
    id: newRecordId(),
    space_id: newRecordId(),
    space_name: 'space',
    scope: 'global',
    subject: null,
    owner_user_id: null,
    slug: 'milliseconds',
    title: 'Milliseconds',
    body: 'Milliseconds survive.',
    delivery: 'demand',
    audiences: ['technical'],
    parent_id: null,
    position: 0,
    project_name: null,
    created_at: timestamp,
    updated_at: timestamp,
    deleted_at: timestamp,
  })

  expect({
    createdAt: mapped.createdAt,
    updatedAt: mapped.updatedAt,
    deletedAt: mapped.deletedAt,
  }).toEqual({
    createdAt: '2026-10-09T12:34:56.789Z',
    updatedAt: '2026-10-09T12:34:56.789Z',
    deletedAt: '2026-10-09T12:34:56.789Z',
  })
  expect({
    form: mapped.form,
    articleSubject: mapped.articleSubject,
    relatedSubjects: mapped.relatedSubjects,
    sourceFiles: mapped.sourceFiles,
    checkedAgainstCommit: mapped.checkedAgainstCommit,
  }).toEqual({
    form: null,
    articleSubject: null,
    relatedSubjects: [],
    sourceFiles: [],
    checkedAgainstCommit: null,
  })
})

test('revision rows carry the batched author display name', () => {
  const mapped = recordDocRevisionRow({
    id: newRecordId(),
    doc_id: newRecordId(),
    scope: 'global',
    subject: null,
    owner_user_id: null,
    slug: 'named-author',
    op: 'set',
    title: 'Named author',
    body: 'Body',
    delivery: 'demand',
    audiences: ['technical'],
    parent_id: null,
    position: 0,
    author: newRecordId(),
    author_name: 'Avery Editor',
    reason: 'Revise',
    session_id: null,
    at: new Date('2026-10-12T12:00:00.000Z'),
  })

  expect(mapped).toMatchObject({ authorName: 'Avery Editor', withheldForAudience: false })
})

test('document rows unwrap source-file strings and name a wrong shape', () => {
  const row = {
    id: 'doc-shape',
    space_id: newRecordId(),
    space_name: 'space',
    scope: 'global',
    subject: null,
    owner_user_id: null,
    slug: 'shape',
    title: 'Shape',
    body: 'Body',
    delivery: 'demand',
    audiences: ['technical'],
    parent_id: null,
    position: 0,
    related_subjects: [],
    project_name: null,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
  }
  expect(recordDocRow({ ...row, source_files: '["src/article.ts"]' }).sourceFiles).toEqual([
    'src/article.ts',
  ])
  expect(() => recordDocRow({ ...row, source_files: { file: 'src/article.ts' } })).toThrow(
    /doc-shape.*doc\.source_files/,
  )
})
