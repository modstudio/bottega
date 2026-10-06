import { expect, test } from 'bun:test'
import { recordDocImportSchema } from './record-api-doc-schemas.ts'

test('legacy doc imports default omitted tree fields and allow the service to mint the id', () => {
  const shared = {
    scope: 'global',
    subject: null,
    slug: 'legacy',
    title: 'Legacy',
    body: 'body',
    delivery: 'demand' as const,
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

  expect(parsed.doc).toMatchObject({ audience: 'technical', parentId: null, position: 0 })
  expect(parsed.doc.id).toBeUndefined()
  expect(parsed.revisions[0]).toMatchObject({
    audience: 'technical',
    parentId: null,
    position: 0,
  })
})
