import { newRecordId } from '../../../shared/record/schema.ts'

export function docImportBody(input: {
  slug: string
  body: string
  updatedAt: string
  deletedAt: string | null
  revisions: Array<{ body: string; op: string; at: string; reason: string }>
}) {
  const createdAt = input.revisions[0]?.at ?? input.updatedAt
  return {
    doc: {
      scope: 'machine',
      subject: null,
      slug: input.slug,
      title: 'Import',
      body: input.body,
      delivery: 'inject' as const,
      audiences: ['technical'],
      projectName: null,
      createdAt,
      updatedAt: input.updatedAt,
      deletedAt: input.deletedAt,
    },
    revisions: input.revisions.map((revision) => ({
      id: newRecordId(),
      scope: 'machine',
      subject: null,
      slug: input.slug,
      op: revision.op,
      title: 'Import',
      body: revision.body,
      delivery: 'inject' as const,
      audiences: ['technical'],
      author: 'proof',
      reason: revision.reason,
      sessionId: null,
      at: revision.at,
    })),
  }
}
