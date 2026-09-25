// concern: record-doc-api-schemas
/** Validates hosted document import payloads at the HTTP edge. */
import { z } from 'zod'
import { isUserCanonSlug } from '../canon/user-canon-home.ts'

const isoSchema = z.string().datetime({ offset: true })
const deliverySchema = z.enum(['inject', 'demand'])
const revisionOpSchema = z.enum([
  'create',
  'set',
  'consume',
  'delete',
  'restore',
  'import',
  'backfill',
])

export const recordDocImportSchema = z.object({
  expectedRevision: z.string().uuid().optional(),
  doc: z.object({
    scope: z.string().min(1),
    subject: z.string().nullable(),
    owner: z.string().uuid().nullable().optional(),
    slug: z.string().min(1),
    title: z.string(),
    body: z.string(),
    delivery: deliverySchema,
    projectName: z.string().nullable().optional(),
    createdAt: isoSchema,
    updatedAt: isoSchema,
    deletedAt: isoSchema.nullable(),
  }),
  revisions: z.array(
    z.object({
      scope: z.string().min(1),
      subject: z.string().nullable(),
      owner: z.string().uuid().nullable().optional(),
      slug: z.string().min(1),
      op: revisionOpSchema,
      title: z.string(),
      body: z.string(),
      delivery: deliverySchema,
      author: z.string().trim().min(1),
      reason: z.string().trim().min(1),
      sessionId: z.string().nullable().optional(),
      at: isoSchema,
    }),
  ),
})

const canonImportBodySchema = z.object({
  rows: z.array(
    z.object({
      slug: z.string().min(1),
      title: z.string(),
      body: z.string(),
    }),
  ),
  expectedRevisions: z.record(z.string(), z.string().uuid()),
  reason: z.string().trim().min(1),
  author: z.string().trim().min(1),
})

export const recordCanonImportSchema = canonImportBodySchema
  .extend({
    address: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('user') }),
      z.object({ kind: z.literal('project'), subject: z.string().trim().min(1) }),
    ]),
  })
  .superRefine((input, context) => {
    if (input.address.kind !== 'user') return
    for (const [index, row] of input.rows.entries()) {
      if (isUserCanonSlug(row.slug)) continue
      context.addIssue({
        code: 'custom',
        path: ['rows', index, 'slug'],
        message: 'slug has no Claude home mapping',
      })
    }
  })
