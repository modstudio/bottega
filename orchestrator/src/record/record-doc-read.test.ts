import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import type { RecordDocRevision } from './record-doc-mapping.ts'
import {
  hostedDocBodyForAudience,
  recordDocListEntries,
  recordDocRevisionHistoryForAudience,
  recordDocWithFrontmatterOnly,
} from './record-doc-read.ts'

const readableId = newRecordId()
const unreadableId = newRecordId()
const timestamp = new Date('2026-11-07T12:00:00.000Z')
const row = (id: string, sourceFiles: unknown) => ({
  id,
  space_id: newRecordId(),
  space_name: 'Docs',
  scope: 'project',
  subject: 'workshop',
  owner_user_id: null,
  slug: id,
  title: id,
  body: 'Body',
  delivery: 'demand',
  audiences: ['technical'],
  parent_id: null,
  position: 0,
  project_name: 'workshop',
  created_at: timestamp,
  updated_at: timestamp,
  deleted_at: null,
  kind: 'article',
  source_files: sourceFiles,
  cursor_at: '2026-11-07T12:00:00.000000Z',
})

test('a document list keeps readable rows and names a malformed row separately', () => {
  const entries = recordDocListEntries([
    row(readableId, ['src/readable.ts']),
    row(unreadableId, { file: 'src/unreadable.ts' }),
  ])
  expect(entries).toEqual([
    expect.objectContaining({ readable: expect.objectContaining({ id: readableId }) }),
    {
      unreadable: {
        id: unreadableId,
        reason: expect.stringContaining(
          `project/workshop/${unreadableId} (${unreadableId}) column doc.source_files is not a JSON list`,
        ),
      },
      cursor: { at: '2026-11-07T12:00:00.000000Z', id: unreadableId },
    },
  ])
})

test('frontmatter-only projection trims only matching rows with frontmatter', () => {
  const doc = recordDocListEntries([row(readableId, [])])[0]!
  if (!('readable' in doc)) throw new Error('fixture row must be readable')
  const context = {
    ...doc.readable,
    slug: '.agents/contexts/api.md',
    body: '---\ndescription: API context\npaths:\n  - api/**\n---\nFull instructions.\n',
  }
  expect(recordDocWithFrontmatterOnly(context, ['.agents/contexts/'])).toMatchObject({
    body: '---\ndescription: API context\npaths:\n  - api/**\n---',
    bodyTrimmed: true,
  })
  expect(
    recordDocWithFrontmatterOnly({ ...context, slug: '.agents/rules/api.md' }, [
      '.agents/contexts/',
      '.agents/reference/',
    ]),
  ).toMatchObject({ body: context.body, bodyTrimmed: false })
  expect(
    recordDocWithFrontmatterOnly({ ...context, slug: '.agents/reference/api.md' }, [
      '.agents/contexts/',
      '.agents/reference/',
    ]),
  ).toMatchObject({
    body: '---\ndescription: API context\npaths:\n  - api/**\n---',
    bodyTrimmed: true,
  })
  expect(
    recordDocWithFrontmatterOnly({ ...context, body: 'Instructions without frontmatter.\n' }, [
      '.agents/contexts/',
    ]),
  ).toMatchObject({ body: 'Instructions without frontmatter.\n', bodyTrimmed: false })
})

const revision: RecordDocRevision = {
  id: '01990000-0000-7000-8000-000000000001',
  docId: '01990000-0000-7000-8000-000000000002',
  scope: 'project',
  subject: 'workshop',
  owner: null,
  slug: 'agreement',
  op: 'set',
  title: 'Agreement',
  body: ':::section{audience="technical"}\nTechnical\n:::',
  withheldForAudience: false,
  delivery: 'demand',
  audiences: ['technical'],
  parentId: null,
  position: 0,
  author: 'editor',
  authorName: null,
  reason: 'Clarify it',
  sessionId: null,
  at: '2026-10-12T12:00:00.000Z',
}

test('the hosted audience helper refuses then projects', () => {
  expect(() => hostedDocBodyForAudience(revision, 'internal')).toThrow(
    'document project/workshop/agreement does not list audience "internal"; choose one of technical',
  )
  expect(hostedDocBodyForAudience(revision, 'technical')).toBe('Technical\n')
})

test('mixed-audience history keeps every row and refuses only from the live document', () => {
  const internal: RecordDocRevision = {
    ...revision,
    id: '01990000-0000-7000-8000-000000000003',
    body: 'Internal body',
    audiences: ['internal'],
  }
  expect(recordDocRevisionHistoryForAudience(internal, [internal, revision], 'internal')).toEqual([
    internal,
    { ...revision, body: '', withheldForAudience: true },
  ])
  expect(() =>
    recordDocRevisionHistoryForAudience(revision, [internal, revision], 'internal'),
  ).toThrow(
    'document project/workshop/agreement does not list audience "internal"; choose one of technical',
  )
})
