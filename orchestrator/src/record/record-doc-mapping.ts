// concern: record-doc-mapping
/** Maps untrusted SQL row shapes into the hosted document service model. */
import {
  type DocArticleSubject,
  type DocAudiences,
  type DocForm,
  type DocKind,
  type DocStatus,
  effectiveDocSummary,
} from '../../../shared/docs.ts'
import type { DocDelivery, DocRevisionOp } from '../doc/doc-write-allowed.ts'
import { recordDocAudiences } from './record-doc-audiences.ts'
import { recordDocList } from './record-doc-list-shape.ts'

function hostedDocList(
  value: unknown,
  input: { document: string; column: string; optional?: boolean },
): unknown[] {
  const decoded = recordDocList(value, input)
  if (decoded.unwrapped)
    console.warn(`unwrapped hosted document JSON string list: ${input.document} ${input.column}`)
  return decoded.values
}

export type RecordDoc = {
  id: string
  spaceId: string
  spaceName: string
  scope: string
  subject: string | null
  owner: string | null
  slug: string
  title: string
  body: string
  delivery: DocDelivery
  audiences: DocAudiences
  parentId: string | null
  position: number
  featured?: boolean
  status?: DocStatus
  kind?: DocKind
  form?: DocForm | null
  articleSubject?: DocArticleSubject | null
  relatedSubjects?: DocArticleSubject[]
  sourceFiles?: string[]
  checkedAgainstCommit?: string | null
  replacementSlug?: string | null
  summary?: string
  summarySource?: 'written' | 'derived'
  projectName: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export type RecordDocRevision = {
  id: string
  docId: string
  scope: string
  subject: string | null
  owner: string | null
  slug: string
  op: DocRevisionOp
  title: string
  body: string
  withheldForAudience: boolean
  delivery: DocDelivery
  audiences: DocAudiences
  parentId: string | null
  position: number
  featured?: boolean
  status?: DocStatus
  kind?: DocKind
  form?: DocForm | null
  articleSubject?: DocArticleSubject | null
  relatedSubjects?: DocArticleSubject[]
  sourceFiles?: string[]
  checkedAgainstCommit?: string | null
  summary?: string | null
  replacementSlug?: string | null
  author: string
  authorName: string | null
  reason: string
  sessionId: string | null
  at: string
}

export type RecordDocImportInput = {
  expectedRevision?: string
  doc: {
    id?: string
    scope: string
    subject: string | null
    owner?: string | null
    slug: string
    title: string
    body: string
    delivery: DocDelivery
    audiences?: DocAudiences
    parentId?: string | null
    position?: number
    featured?: boolean
    status?: DocStatus
    kind?: DocKind
    form?: DocForm | null
    articleSubjectId?: string | null
    relatedSubjectIds?: string[]
    sourceFiles?: string[]
    checkedAgainstCommit?: string | null
    summary?: string | null
    replacementSlug?: string | null
    projectName?: string | null
    projectId?: string | null
    createdAt: string
    updatedAt: string
    deletedAt: string | null
  }
  revisions: Array<{
    scope: string
    subject: string | null
    owner?: string | null
    slug: string
    op: DocRevisionOp
    title: string
    body: string
    delivery: DocDelivery
    audiences?: DocAudiences
    parentId?: string | null
    position?: number
    featured?: boolean
    status?: DocStatus
    kind?: DocKind
    form?: DocForm | null
    articleSubjectId?: string | null
    relatedSubjectIds?: string[]
    sourceFiles?: string[]
    checkedAgainstCommit?: string | null
    summary?: string | null
    replacementSlug?: string | null
    author: string
    reason: string
    sessionId?: string | null
    at: string
  }>
}

export type NormalizedRecordDocImport = {
  doc: Omit<
    RecordDocImportInput['doc'],
    | 'id'
    | 'audiences'
    | 'parentId'
    | 'position'
    | 'featured'
    | 'status'
    | 'kind'
    | 'form'
    | 'articleSubjectId'
    | 'relatedSubjectIds'
    | 'sourceFiles'
    | 'checkedAgainstCommit'
    | 'replacementSlug'
  > & {
    id: string
    audiences: DocAudiences
    parentId: string | null
    position: number
    featured: boolean
    status: DocStatus
    kind: DocKind
    form?: DocForm | null
    articleSubjectId?: string | null
    relatedSubjectIds?: string[]
    sourceFiles?: string[]
    checkedAgainstCommit?: string | null
    replacementSlug: string | null
  }
  revisions: Array<
    Omit<
      RecordDocImportInput['revisions'][number],
      | 'audiences'
      | 'parentId'
      | 'position'
      | 'featured'
      | 'status'
      | 'kind'
      | 'form'
      | 'articleSubjectId'
      | 'relatedSubjectIds'
      | 'sourceFiles'
      | 'checkedAgainstCommit'
      | 'replacementSlug'
    > & {
      audiences: DocAudiences
      parentId: string | null
      position: number
      featured: boolean
      status: DocStatus
      kind: DocKind
      form: DocForm | null
      articleSubjectId: string | null
      relatedSubjectIds: string[]
      sourceFiles: string[]
      checkedAgainstCommit: string | null
      replacementSlug: string | null
    }
  >
}

type DocIdentity = {
  scope: string
  subject: string | null
  owner?: string | null
  slug: string
}

export function normalizeRecordDocImport(
  input: RecordDocImportInput,
  mintedId: string,
): NormalizedRecordDocImport {
  return {
    doc: {
      ...input.doc,
      id: input.doc.id ?? mintedId,
      audiences: input.doc.audiences ?? ['technical'],
      parentId: input.doc.parentId ?? null,
      position: input.doc.position ?? 0,
      featured: input.doc.featured ?? false,
      status: input.doc.status ?? 'current',
      kind: input.doc.kind ?? 'working',
      replacementSlug: input.doc.replacementSlug ?? null,
    },
    revisions: input.revisions.map((revision) => ({
      ...revision,
      audiences: revision.audiences ?? ['technical'],
      parentId: revision.parentId ?? null,
      position: revision.position ?? 0,
      featured: revision.featured ?? false,
      status: revision.status ?? 'current',
      kind: revision.kind ?? 'working',
      form: revision.form ?? null,
      articleSubjectId: revision.articleSubjectId ?? null,
      relatedSubjectIds: revision.relatedSubjectIds ?? [],
      sourceFiles: revision.sourceFiles ?? [],
      checkedAgainstCommit: revision.checkedAgainstCommit ?? null,
      summary: revision.summary ?? null,
      replacementSlug: revision.replacementSlug ?? null,
    })),
  }
}

export function importedLiveArticleFields(
  incoming: Pick<
    NormalizedRecordDocImport['doc'],
    | 'form'
    | 'articleSubjectId'
    | 'relatedSubjectIds'
    | 'sourceFiles'
    | 'checkedAgainstCommit'
    | 'summary'
  >,
  existing?: Record<string, unknown>,
  existingRelatedSubjectIds: readonly string[] = [],
): {
  form: DocForm | null
  articleSubjectId: string | null
  relatedSubjectIds: string[]
  sourceFiles: string[]
  checkedAgainstCommit: string | null
  summary: string | null
} {
  return {
    form:
      incoming.form !== undefined
        ? incoming.form
        : existing?.form == null
          ? null
          : (String(existing.form) as DocForm),
    articleSubjectId:
      incoming.articleSubjectId !== undefined
        ? incoming.articleSubjectId
        : existing?.article_subject_id == null
          ? null
          : String(existing.article_subject_id),
    relatedSubjectIds:
      incoming.relatedSubjectIds !== undefined
        ? incoming.relatedSubjectIds
        : [...existingRelatedSubjectIds],
    sourceFiles:
      incoming.sourceFiles ??
      hostedDocList(existing?.source_files, {
        document: existing?.id == null ? 'incoming document' : String(existing.id),
        column: 'doc.source_files',
        optional: true,
      }).map(String),
    checkedAgainstCommit:
      incoming.checkedAgainstCommit !== undefined
        ? incoming.checkedAgainstCommit
        : existing?.checked_against_commit == null
          ? null
          : String(existing.checked_against_commit),
    summary:
      incoming.summary !== undefined
        ? incoming.summary
        : existing?.summary == null
          ? null
          : String(existing.summary),
  }
}

export function recordDocRevisionIdentityRefusal(
  live: DocIdentity,
  revision: DocIdentity,
  operation: 'import' | 'restore',
): string | null {
  if (
    revision.scope === live.scope &&
    revision.subject === live.subject &&
    (revision.owner ?? null) === (live.owner ?? null)
  ) {
    return null
  }
  return `refusing ${operation} for ${live.scope}/${live.subject ?? '_'}/${live.slug}: revision scope, subject, and owner must match the live document; cleared by: ${operation} a revision recorded for that document identity`
}

export function newerHostedImportRefusal(
  existing: Record<string, unknown> | undefined,
  incoming: NormalizedRecordDocImport['doc'],
): string | null {
  if (!existing || existing.deleted_at != null || String(existing.body) === incoming.body)
    return null
  const hostedUpdated = Date.parse(recordDocIso(existing.updated_at) ?? '')
  if (!Number.isFinite(hostedUpdated) || hostedUpdated <= Date.parse(incoming.updatedAt))
    return null
  const subject = existing.subject == null ? '' : String(existing.subject)
  return `refusing import: hosted doc at ${String(existing.scope)}/${subject}/${String(existing.slug)} has a different body and newer updated_at`
}

const recordDocIso = (value: unknown) =>
  value == null ? null : (value instanceof Date ? value : new Date(String(value))).toISOString()

export function recordDocRow(row: Record<string, unknown>): RecordDoc {
  const document = `${String(row.scope)}/${row.subject == null ? '_' : String(row.subject)}/${String(row.slug)} (${String(row.id)})`
  const relatedSubjects = hostedDocList(row.related_subjects, {
    document,
    column: 'doc.related_subjects',
    optional: true,
  })
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    spaceName: String(row.space_name),
    scope: String(row.scope),
    subject: row.subject == null ? null : String(row.subject),
    owner: row.owner_user_id == null ? null : String(row.owner_user_id),
    slug: String(row.slug),
    title: String(row.title),
    body: String(row.body),
    delivery: String(row.delivery) as DocDelivery,
    audiences: recordDocAudiences(row.audiences),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    position: Number(row.position),
    featured: row.featured == null ? false : Boolean(row.featured),
    status: (row.status == null ? 'current' : String(row.status)) as DocStatus,
    kind: (row.kind == null ? 'working' : String(row.kind)) as DocKind,
    form: row.form == null ? null : (String(row.form) as DocForm),
    articleSubject:
      row.article_subject_id == null
        ? null
        : { id: String(row.article_subject_id), name: String(row.article_subject_name) },
    relatedSubjects: relatedSubjects.map((subject) => ({
      id: String((subject as Record<string, unknown>).id),
      name: String((subject as Record<string, unknown>).name),
    })),
    sourceFiles: hostedDocList(row.source_files, {
      document,
      column: 'doc.source_files',
      optional: true,
    }).map(String),
    checkedAgainstCommit:
      row.checked_against_commit == null ? null : String(row.checked_against_commit),
    replacementSlug: row.replacement_slug == null ? null : String(row.replacement_slug),
    ...effectiveDocSummary(row.summary == null ? null : String(row.summary), String(row.body)),
    projectName: row.project_name == null ? null : String(row.project_name),
    createdAt: recordDocIso(row.created_at)!,
    updatedAt: recordDocIso(row.updated_at)!,
    deletedAt: recordDocIso(row.deleted_at),
  }
}

export function recordDocRevisionRow(row: Record<string, unknown>): RecordDocRevision {
  const document = `revision ${String(row.id)} of document ${String(row.doc_id)}`
  const relatedSubjects = hostedDocList(row.related_subjects, {
    document,
    column: 'doc_revision.related_subject_ids',
    optional: true,
  })
  return {
    id: String(row.id),
    docId: String(row.doc_id),
    scope: String(row.scope),
    subject: row.subject == null ? null : String(row.subject),
    owner: row.owner_user_id == null ? null : String(row.owner_user_id),
    slug: String(row.slug),
    op: String(row.op) as DocRevisionOp,
    title: String(row.title),
    body: String(row.body),
    withheldForAudience: false,
    delivery: String(row.delivery) as DocDelivery,
    audiences: recordDocAudiences(row.audiences),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    position: Number(row.position),
    featured: row.featured == null ? false : Boolean(row.featured),
    status: (row.status == null ? 'current' : String(row.status)) as DocStatus,
    kind: (row.kind == null ? 'working' : String(row.kind)) as DocKind,
    form: row.form == null ? null : (String(row.form) as DocForm),
    articleSubject:
      row.article_subject_id == null
        ? null
        : { id: String(row.article_subject_id), name: String(row.article_subject_name) },
    relatedSubjects: relatedSubjects.map((subject) => ({
      id: String((subject as Record<string, unknown>).id),
      name: String((subject as Record<string, unknown>).name),
    })),
    sourceFiles: hostedDocList(row.source_files, {
      document,
      column: 'doc_revision.source_files',
      optional: true,
    }).map(String),
    checkedAgainstCommit:
      row.checked_against_commit == null ? null : String(row.checked_against_commit),
    summary: row.summary == null ? null : String(row.summary),
    replacementSlug: row.replacement_slug == null ? null : String(row.replacement_slug),
    author: String(row.author),
    authorName: row.author_name == null ? null : String(row.author_name),
    reason: String(row.reason),
    sessionId: row.session_id == null ? null : String(row.session_id),
    at: recordDocIso(row.at)!,
  }
}
