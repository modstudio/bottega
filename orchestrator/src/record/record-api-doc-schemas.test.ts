import { expect, test } from 'bun:test'
import {
  docWriteContextSchema,
  recordDocImportSchema,
  recordDocUpsertSchema,
} from './record-api-doc-schemas.ts'
import { normalizeRecordDocImport } from './record-doc-mapping.ts'

test('doc imports require audience sets and allow the service to mint the id', () => {
  const shared = {
    scope: 'global',
    subject: null,
    slug: 'legacy',
    title: 'Legacy',
    body: 'body',
    delivery: 'demand' as const,
    audiences: ['technical'] as const,
  }
  const parsed = recordDocImportSchema.parse({
    doc: {
      ...shared,
      createdAt: '2026-10-06T00:00:00.000Z',
      updatedAt: '2026-10-06T00:00:00.000Z',
      deletedAt: null,
    },
    revisions: [
      {
        id: '01990000-0000-7000-8000-000000000098',
        ...shared,
        op: 'create',
        author: 'legacy-client',
        reason: 'legacy import',
        at: '2026-10-06T00:00:00.000Z',
      },
    ],
  })

  expect(parsed.doc).toMatchObject({
    audiences: ['technical'],
    parentId: null,
    position: 0,
    featured: false,
  })
  expect(parsed.doc.id).toBeUndefined()
  expect(parsed.revisions[0]).toMatchObject({
    audiences: ['technical'],
    parentId: null,
    position: 0,
    featured: false,
  })
  const mintedId = '01990000-0000-7000-8000-000000000099'
  expect(normalizeRecordDocImport(parsed, mintedId)).toMatchObject({
    doc: { id: mintedId, audiences: ['technical'], parentId: null, position: 0, featured: false },
    revisions: [{ audiences: ['technical'], parentId: null, position: 0, featured: false }],
  })
})

test('hosted writes reject invalid audience sets and normalize their order', () => {
  const input = {
    scope: 'global',
    subject: null,
    slug: 'audiences',
    title: 'Audiences',
    body: 'Body.',
    delivery: 'demand',
    reason: 'test audiences',
    author: 'test',
  }
  expect(recordDocUpsertSchema.safeParse({ ...input, audiences: [] }).success).toBe(false)
  expect(
    recordDocUpsertSchema.safeParse({ ...input, audiences: ['internal', 'internal'] }).success,
  ).toBe(false)
  expect(recordDocUpsertSchema.safeParse({ ...input, audiences: ['user'] }).success).toBe(false)
  expect(recordDocUpsertSchema.safeParse({ ...input, audiences: ['other'] }).success).toBe(false)
  expect(
    recordDocUpsertSchema.parse({ ...input, audiences: ['customer', 'technical'] }).audiences,
  ).toEqual(['technical', 'customer'])
})

test('hosted updates may omit delivery so the write service can preserve it', () => {
  const parsed = recordDocUpsertSchema.safeParse({
    scope: 'global',
    subject: null,
    slug: 'body-only',
    title: 'Body only',
    body: 'Changed body.',
    reason: 'edit body',
    author: 'test',
  })
  expect(parsed.success).toBe(true)
  if (parsed.success) expect('delivery' in parsed.data).toBe(false)
})

test('hosted document write schemas preserve the writing session', () => {
  const sessionId = 'session-that-authored-the-revision'
  expect(
    recordDocUpsertSchema.parse({
      scope: 'global',
      subject: null,
      slug: 'session-attribution',
      title: 'Session attribution',
      body: 'Body.',
      reason: 'attribute the write',
      author: 'test',
      sessionId,
    }).sessionId,
  ).toBe(sessionId)
  expect(
    docWriteContextSchema.parse({ reason: 'attribute the write', author: 'test', sessionId })
      .sessionId,
  ).toBe(sessionId)
})

test('hosted writes refuse malformed checked-against commits with the remedy', () => {
  expect(() =>
    recordDocUpsertSchema.parse({
      scope: 'project',
      subject: 'project',
      slug: 'article',
      title: 'Article',
      body: 'Body.',
      delivery: 'demand',
      kind: 'article',
      checkedAgainstCommit: 'ABC123',
      reason: 'test commit validation',
      author: 'test',
    }),
  ).toThrow('use the full lowercase 40-character hexadecimal git commit id')
})
