import { z } from 'zod'
import {
  DOC_AUDIENCES,
  DOC_FORMS,
  DOC_KINDS,
  DOC_STATUSES,
  type DocAudiences,
  type DocKind,
  type DocScope,
  type DocStatus,
} from '../../shared/docs.ts'

export const ArticleDocFieldsSchema = z.object({
  form: z.enum(DOC_FORMS).nullable().optional(),
  articleSubject: z.object({ id: z.string().uuid(), name: z.string() }).nullable().optional(),
  relatedSubjects: z.array(z.object({ id: z.string().uuid(), name: z.string() })).optional(),
  sourceFiles: z.array(z.string()).optional(),
  checkedAgainstCommit: z.string().nullable().optional(),
})
type ArticleDocFields = z.infer<typeof ArticleDocFieldsSchema>

export type ContractDocRow = ArticleDocFields & {
  id: number
  scope: DocScope
  subject: string | null
  slug: string
  title: string
  body: string
  summary?: string | null
  delivery: 'inject' | 'demand'
  audiences: DocAudiences
  parent_id: number | null
  parent_slug: string | null
  position: number
  featured?: boolean
  status?: DocStatus
  kind: DocKind
  replacement_slug?: string | null
  revision: string | null
  created_at: string
  updated_at: string
}

export const DocTreeItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  parentId: z.string().nullable(),
  position: z.number().int(),
  updatedAt: z.string(),
  scope: z.string(),
  subject: z.string().nullable(),
  audiences: z.array(z.enum(DOC_AUDIENCES)).nonempty(),
  delivery: z.enum(['inject', 'demand']).optional(),
  summary: z.string().optional(),
  summarySource: z.enum(['written', 'derived']),
  featured: z.boolean().optional(),
  status: z.enum(DOC_STATUSES).optional(),
  kind: z.enum(DOC_KINDS),
  form: z.enum(DOC_FORMS).nullable().optional(),
  replacementSlug: z.string().nullable().optional(),
})

export const DocSchema = DocTreeItemSchema.extend({ body: z.string() })

export const DocSearchMatchSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  audiences: z.array(z.enum(DOC_AUDIENCES)).nonempty(),
  status: z.enum(DOC_STATUSES).default('current'),
  kind: z.enum(DOC_KINDS),
  snippet: z.string(),
  summary: z.string(),
  summarySource: z.enum(['written', 'derived']),
  spaceName: z.string().optional(),
  highlights: z
    .array(
      z.object({
        start: z.number().int().nonnegative(),
        length: z.number().int().nonnegative(),
      }),
    )
    .default([]),
})

export const DocTreeSchema = z.object({ items: z.array(DocTreeItemSchema) })
export const DocSearchSchema = z.object({ items: z.array(DocSearchMatchSchema) })

export type DocSearchMatch = z.infer<typeof DocSearchMatchSchema>
