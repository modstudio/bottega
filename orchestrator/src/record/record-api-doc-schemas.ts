// concern: record-doc-api-schemas
/** Validates hosted document import payloads at the HTTP edge. */
import { z } from 'zod'
import {
  DOC_AUDIENCES,
  DOC_KINDS,
  DOC_STATUSES,
  normalizeDocAudiences,
} from '../../../shared/docs.ts'
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
const audiencesSchema = z
  .array(z.enum(DOC_AUDIENCES))
  .nonempty()
  .refine(
    (values) => new Set(values).size === values.length,
    'doc audiences must not contain duplicates',
  )
  .transform(normalizeDocAudiences)

const recordDocTreeFieldShape = {
  audiences: audiencesSchema.optional(),
  parentRecordId: z.string().uuid().nullable().optional(),
  position: z.number().int().optional(),
  featured: z.boolean().optional(),
  status: z.enum(DOC_STATUSES).optional(),
  kind: z.enum(DOC_KINDS).optional(),
  replacementSlug: z.string().min(1).nullable().optional(),
}

export const recordDocUpsertSchema = z.object({
  scope: z.string().min(1),
  subject: z.string().nullable(),
  owner: z.string().uuid().nullable().optional(),
  slug: z.string().min(1),
  title: z.string(),
  body: z.string(),
  delivery: deliverySchema,
  ...recordDocTreeFieldShape,
  projectName: z.string().nullable().optional(),
  reason: z.string().trim().min(1),
  author: z.string().trim().min(1),
  forceInject: z.string().min(1).optional(),
  op: revisionOpSchema.optional(),
  at: isoSchema.optional(),
  id: z.string().uuid().optional(),
  revisionId: z.string().uuid().optional(),
  expectedRevision: z.string().uuid().optional(),
})

export const recordDocImportSchema = z.object({
  expectedRevision: z.string().uuid().optional(),
  doc: z.object({
    id: z.string().uuid().optional(),
    scope: z.string().min(1),
    subject: z.string().nullable(),
    owner: z.string().uuid().nullable().optional(),
    slug: z.string().min(1),
    title: z.string(),
    body: z.string(),
    delivery: deliverySchema,
    audiences: audiencesSchema,
    parentId: z.string().uuid().nullable().optional().default(null),
    position: z.number().int().optional().default(0),
    featured: z.boolean().optional().default(false),
    status: z.enum(DOC_STATUSES).optional().default('current'),
    kind: z.enum(DOC_KINDS).optional().default('working'),
    replacementSlug: z.string().min(1).nullable().optional().default(null),
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
      audiences: audiencesSchema,
      parentId: z.string().uuid().nullable().optional().default(null),
      position: z.number().int().optional().default(0),
      featured: z.boolean().optional().default(false),
      status: z.enum(DOC_STATUSES).optional().default('current'),
      kind: z.enum(DOC_KINDS).optional().default('working'),
      replacementSlug: z.string().min(1).nullable().optional().default(null),
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
