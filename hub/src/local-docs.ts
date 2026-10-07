import { docSummary } from '../../shared/docs.ts'
import { DocSchema, DocTreeItemSchema } from './doc-contract.ts'
import { type DocRow, docGet, docList } from './orch.ts'

export type LocalDocFilters = Pick<
  NonNullable<Parameters<typeof docList>[0]>,
  'scope' | 'subject' | 'audience'
>

function localDocContract(
  row: DocRow,
  includeBody: false,
): ReturnType<typeof DocTreeItemSchema.parse>
function localDocContract(row: DocRow, includeBody: true): ReturnType<typeof DocSchema.parse>
function localDocContract(row: DocRow, includeBody: boolean) {
  const item = {
    id: String(row.id),
    slug: row.slug,
    title: row.title,
    parentId: row.parent_id === null ? null : String(row.parent_id),
    position: row.position,
    updatedAt: row.updated_at,
    scope: row.scope,
    subject: row.subject,
    audience: row.audience,
    delivery: row.delivery,
    summary: docSummary(row.body),
    featured: Boolean(row.featured),
  }
  return includeBody ? DocSchema.parse({ ...item, body: row.body }) : DocTreeItemSchema.parse(item)
}

export async function localDocsTree(filters: LocalDocFilters = {}) {
  return { items: (await docList(filters)).map((row) => localDocContract(row, false)) }
}

export async function localDocRead(scope: string, subject: string | null, slug: string) {
  return localDocContract(await docGet(scope, subject, slug), true)
}
