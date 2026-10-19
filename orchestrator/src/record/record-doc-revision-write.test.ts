import { expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { insertRecordDocRevision } from './record-doc-revision-write.ts'

type StoredRevision = Record<string, unknown> & { id: string }

function fakeRevisionSql() {
  let stored: StoredRevision | null = null
  let inserts = 0
  let updates = 0
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const statement = strings.join('?')
    if (statement === '?::jsonb') return values[0]
    if (statement.includes('SELECT id,space_id,doc_id,scope,subject')) {
      return stored ? [stored] : []
    }
    if (statement.includes('INSERT INTO doc_revision')) {
      inserts += 1
      stored = {
        id: String(values[0]),
        space_id: String(values[1]),
        doc_id: String(values[2]),
        scope: String(values[3]),
        subject: values[4],
        owner_user_id: values[5],
        slug: String(values[6]),
        project_id: values[7],
        op: String(values[8]),
        title: String(values[9]),
        body: String(values[10]),
        delivery: String(values[11]),
        audiences: ['technical'],
        featured: false,
        status: 'current',
        kind: 'working',
        form: values[16],
        article_subject_id: values[17],
        related_subject_ids: [],
        source_files: [],
        checked_against_commit: values[20],
        summary: values[21],
        replacement_slug: values[22],
        parent_id: values[23],
        position: values[24],
        author: String(values[25]),
        reason: String(values[26]),
        session_id: values[27],
        at: String(values[28]),
      }
      return []
    }
    if (statement.includes('UPDATE doc SET latest_revision_id')) {
      updates += 1
      return []
    }
    throw new Error(`unexpected SQL in revision fixture: ${statement}`)
  }) as unknown as SQL
  sql.array = ((values: unknown[]) => values) as unknown as SQL['array']
  return { sql, inserts: () => inserts, updates: () => updates }
}

const revisionInput = (
  overrides: Partial<Parameters<typeof insertRecordDocRevision>[1]> = {},
): Parameters<typeof insertRecordDocRevision>[1] => ({
  id: '01990000-0000-7000-8000-000000002026',
  spaceId: newRecordId(),
  docId: newRecordId(),
  scope: 'project',
  subject: PLATFORM_SLUG,
  owner: null,
  slug: 'uuid-keys',
  projectId: null,
  op: 'import' as const,
  title: 'UUID keys',
  body: 'Body.',
  delivery: 'demand' as const,
  audiences: ['technical'],
  parentId: null,
  position: 0,
  author: 'importer',
  reason: 'q2026 replay proof',
  sessionId: null,
  at: '2026-10-19T12:00:00.000Z',
  ...overrides,
})

const snapshotChanges: Array<[string, Partial<Parameters<typeof insertRecordDocRevision>[1]>]> = [
  ['space', { spaceId: newRecordId() }],
  ['document', { docId: newRecordId() }],
  ['scope', { scope: 'global' }],
  ['subject', { subject: 'other' }],
  ['owner', { owner: newRecordId() }],
  ['slug', { slug: 'other-slug' }],
  ['project', { projectId: newRecordId() }],
  ['operation', { op: 'set' }],
  ['title', { title: 'Other title' }],
  ['body', { body: 'Other body.' }],
  ['delivery', { delivery: 'inject' }],
  ['audiences', { audiences: ['customer'] }],
  ['parent', { parentId: newRecordId() }],
  ['position', { position: 1 }],
  ['featured', { featured: true }],
  ['status', { status: 'draft' }],
  ['kind', { kind: 'article' }],
  ['form', { form: 'feature' }],
  ['article subject', { articleSubjectId: newRecordId() }],
  ['related subjects', { relatedSubjectIds: [newRecordId()] }],
  ['source files', { sourceFiles: ['src/other.ts'] }],
  ['checked commit', { checkedAgainstCommit: 'abc123' }],
  ['summary', { summary: 'Other summary.' }],
  ['replacement slug', { replacementSlug: 'replacement' }],
  ['author', { author: 'other-author' }],
  ['reason', { reason: 'other reason' }],
  ['session', { sessionId: newRecordId() }],
  ['timestamp', { at: '2026-10-19T12:00:01.000Z' }],
]

test.each(snapshotChanges)(
  'hosted revision import refuses the same UUID when %s differs',
  async (_field, change) => {
    const fixture = fakeRevisionSql()
    const input = revisionInput()
    await insertRecordDocRevision(fixture.sql, input)
    await expect(insertRecordDocRevision(fixture.sql, { ...input, ...change })).rejects.toThrow(
      `document revision UUID ${input.id} already belongs to another space, document, or content`,
    )
    expect(fixture.inserts()).toBe(1)
    expect(fixture.updates()).toBe(1)
  },
)

test('hosted revision import replays the same revision idempotently in one space and document', async () => {
  const fixture = fakeRevisionSql()
  const input = revisionInput()
  expect(await insertRecordDocRevision(fixture.sql, input)).toBe(input.id!)
  expect(await insertRecordDocRevision(fixture.sql, input)).toBe(input.id!)
  expect(fixture.inserts()).toBe(1)
  expect(fixture.updates()).toBe(2)
})
