import { type DocAudience, effectiveDocSummary } from '../../shared/docs.ts'
import { ArticleDocFieldsSchema, DocSchema, DocTreeItemSchema } from './doc-contract.ts'
import { type DocRow, docGet, docList } from './orch.ts'
import { docRevision } from './orch-doc-revision.ts'

const LocalTreeSchema = DocTreeItemSchema.extend(ArticleDocFieldsSchema.shape)
const LocalDocSchema = DocSchema.extend(ArticleDocFieldsSchema.shape)

export type LocalDocFilters = Pick<
  NonNullable<Parameters<typeof docList>[0]>,
  'scope' | 'subject' | 'audience' | 'status' | 'kind'
>

function localDocContract(row: DocRow, includeBody: false): ReturnType<typeof LocalTreeSchema.parse>
function localDocContract(row: DocRow, includeBody: true): ReturnType<typeof LocalDocSchema.parse>
function localDocContract(row: DocRow, includeBody: boolean) {
  const item = {
    id: row.record_id,
    slug: row.slug,
    title: row.title,
    parentId: row.parent_record_id,
    position: row.position,
    updatedAt: row.updated_at,
    scope: row.scope,
    subject: row.subject,
    audiences: row.audiences,
    delivery: row.delivery,
    ...effectiveDocSummary(row.summary, row.body),
    featured: Boolean(row.featured),
    status: row.status ?? 'current',
    kind: row.kind,
    replacementSlug: row.replacement_slug ?? null,
    form: row.form ?? null,
    articleSubject: row.articleSubject ?? null,
    relatedSubjects: row.relatedSubjects ?? [],
    sourceFiles: row.sourceFiles ?? [],
    checkedAgainstCommit: row.checkedAgainstCommit ?? null,
  }
  return includeBody
    ? LocalDocSchema.parse({ ...item, body: row.body })
    : LocalTreeSchema.parse(item)
}

export async function localDocsTree(filters: LocalDocFilters = {}) {
  return { items: (await docList(filters)).map((row) => localDocContract(row, false)) }
}

export async function localDocRead(
  scope: string,
  subject: string | null,
  slug: string,
  audience?: DocAudience,
) {
  return localDocContract(await docGet(scope, subject, slug, audience), true)
}

export async function localDocRevisionRead(
  scope: string,
  subject: string | null,
  slug: string,
  revisionId: string | number,
  audience?: DocAudience,
) {
  return docRevision(scope, subject, slug, revisionId, audience)
}
