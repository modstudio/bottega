import { z } from 'zod'
import { DOC_AUDIENCES, DOC_KINDS, DOC_STATUSES, normalizeDocAudiences } from '../../shared/docs.ts'

export const HostedDocAudiencesSchema = z
  .array(z.union([z.enum(DOC_AUDIENCES), z.literal('user')]))
  .nonempty()
  .transform((audiences) => {
    const tolerated = audiences.map((audience) => (audience === 'user' ? 'internal' : audience))
    return normalizeDocAudiences([...new Set(tolerated)])
  })

export const DocTreeItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  parentId: z.string().nullable(),
  position: z.number().int(),
  updatedAt: z.string(),
  scope: z.string(),
  subject: z.string().nullable(),
  audiences: HostedDocAudiencesSchema,
  delivery: z.enum(['inject', 'demand']).optional(),
  summary: z.string().optional(),
  featured: z.boolean().optional(),
  status: z.enum(DOC_STATUSES).optional(),
  kind: z.enum(DOC_KINDS).optional(),
  replacementSlug: z.string().nullable().optional(),
})

export const DocSchema = DocTreeItemSchema.extend({ body: z.string() })

const DocSearchMatchSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  audiences: HostedDocAudiencesSchema,
  status: z.enum(DOC_STATUSES).default('current'),
  kind: z.enum(DOC_KINDS).default('working'),
  snippet: z.string(),
  spaceName: z.string().optional(),
  matchPosition: z.number().int().nonnegative().nullable().default(null),
})

export const DocTreeSchema = z.object({ items: z.array(DocTreeItemSchema) })
export const DocSearchSchema = z.object({ items: z.array(DocSearchMatchSchema) })

export type DocSearchMatch = z.infer<typeof DocSearchMatchSchema>
