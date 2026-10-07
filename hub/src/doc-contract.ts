import { z } from 'zod'
import { DOC_AUDIENCES } from '../../shared/docs.ts'

export const DocTreeItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  parentId: z.string().nullable(),
  position: z.number().int(),
  updatedAt: z.string(),
  scope: z.string(),
  subject: z.string().nullable(),
  audience: z.enum(DOC_AUDIENCES),
  delivery: z.enum(['inject', 'demand']).optional(),
  summary: z.string().optional(),
  featured: z.boolean().optional(),
})

export const DocSchema = DocTreeItemSchema.extend({ body: z.string() })

const DocSearchMatchSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  snippet: z.string(),
  spaceName: z.string().optional(),
  matchPosition: z.number().int().nonnegative().nullable().default(null),
})

export const DocTreeSchema = z.object({ items: z.array(DocTreeItemSchema) })
export const DocSearchSchema = z.object({ items: z.array(DocSearchMatchSchema) })

export type DocSearchMatch = z.infer<typeof DocSearchMatchSchema>
