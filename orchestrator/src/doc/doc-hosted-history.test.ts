import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { RecordApiRequestError } from '../record/record-api-client.ts'
import type { RecordDocRevision } from '../record/record-doc-mapping.ts'
import {
  hostedDocRevisionRead,
  mapHostedDocRevisions,
  readHostedDocRevisions,
} from './doc-hosted-history.ts'

const docId = newRecordId()
const earlierId = newRecordId()
const laterId = newRecordId()

function revision(overrides: Partial<RecordDocRevision> = {}): RecordDocRevision {
  return {
    id: earlierId,
    docId,
    scope: 'global',
    subject: null,
    owner: null,
    slug: 'hosted-history',
    op: 'create',
    title: 'Hosted history',
    body: 'héllo',
    withheldForAudience: false,
    delivery: 'demand',
    audiences: ['technical'],
    parentId: null,
    position: 3,
    featured: true,
    status: 'superseded',
    kind: 'article',
    form: 'reference',
    articleSubject: { id: newRecordId(), name: 'Revision history' },
    relatedSubjects: [
      { id: newRecordId(), name: 'Documents' },
      { id: newRecordId(), name: 'Hosted record' },
    ],
    sourceFiles: ['docs/one.md', 'docs/two.md'],
    checkedAgainstCommit: 'abc123',
    summary: 'Every field.',
    replacementSlug: 'replacement',
    author: newRecordId(),
    authorName: 'Avery Editor',
    reason: 'Initial hosted revision',
    sessionId: 'session-a',
    at: '2026-11-01T10:00:00.000Z',
    ...overrides,
  }
}

describe('hosted document history', () => {
  test('maps every printed field and derives document-local number and UTF-8 bytes', () => {
    const read = hostedDocRevisionRead([revision()])
    expect(read.revisions).toEqual([
      expect.objectContaining({
        number: 1,
        record_id: earlierId,
        op: 'create',
        kind: 'article',
        form: 'reference',
        articleSubject: expect.objectContaining({ name: 'Revision history' }),
        relatedSubjects: expect.any(Array),
        sourceFiles: expect.any(Array),
        checkedAgainstCommit: 'abc123',
        summary: 'Every field.',
        status: 'superseded',
        replacement_slug: 'replacement',
        author: expect.any(String),
        authorName: 'Avery Editor',
        at: '2026-11-01T10:00:00.000Z',
        bytes: 6,
        reason: 'Initial hosted revision',
      }),
    ])
    expect(read.revisions[0]?.relatedSubjects).toHaveLength(2)
    expect(read.revisions[0]?.sourceFiles).toHaveLength(2)
  })

  test('numbers the complete history oldest-first and resolves numeric diffs', () => {
    const later = revision({
      id: laterId,
      op: 'set',
      body: 'later',
      reason: 'Later hosted revision',
      at: '2026-11-02T10:00:00.000Z',
    })
    expect(mapHostedDocRevisions([later, revision()]).map(({ number }) => number)).toEqual([2, 1])
    expect(hostedDocRevisionRead([later, revision()]).diff('1', '2')).toContain('-héllo\n+later')
  })

  test('a failed hosted read refuses instead of returning local history', async () => {
    await expect(
      readHostedDocRevisions({
        address: 'global/_/hosted-history',
        listRevisions: async () => {
          throw new RecordApiRequestError('server unavailable', 'server', 503)
        },
      }),
    ).rejects.toThrow(
      'could not read hosted revisions for global/_/hosted-history: server unavailable; run bottega record whoami to verify sign-in, or retry',
    )
  })

  test('a definite hosted not-found selects local history', async () => {
    expect(
      await readHostedDocRevisions({
        address: 'global/_/local-only',
        listRevisions: async () => {
          throw new RecordApiRequestError('doc not found', 'refused', 404)
        },
      }),
    ).toBeNull()
  })
})
