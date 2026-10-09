import { expect, test } from 'bun:test'
import { recordDocImportSchema, recordDocUpsertSchema } from './record-api-doc-schemas.ts'
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
    recordDocUpsertSchema.safeParse({ ...input, audiences: ['user', 'user'] }).success,
  ).toBe(false)
  expect(recordDocUpsertSchema.safeParse({ ...input, audiences: ['other'] }).success).toBe(false)
  expect(
    recordDocUpsertSchema.parse({ ...input, audiences: ['technical', 'user'] }).audiences,
  ).toEqual(['user', 'technical'])
})
