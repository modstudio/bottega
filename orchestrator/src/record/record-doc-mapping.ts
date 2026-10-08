// concern: record-doc-mapping
/** Maps untrusted SQL row shapes into the hosted document service model. */
import { type DocAudience, type DocKind, type DocStatus, docSummary } from '../../../shared/docs.ts'
import type { DocDelivery, DocRevisionOp } from '../doc/doc-write-allowed.ts'

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
  audience: DocAudience
  parentId: string | null
  position: number
  featured?: boolean
  status?: DocStatus
  kind?: DocKind
  replacementSlug?: string | null
  summary?: string
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
  delivery: DocDelivery
  audience: DocAudience
  parentId: string | null
  position: number
  featured?: boolean
  status?: DocStatus
  kind?: DocKind
  replacementSlug?: string | null
  author: string
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
    audience?: DocAudience
    parentId?: string | null
    position?: number
    featured?: boolean
    status?: DocStatus
    kind?: DocKind
    replacementSlug?: string | null
    projectName?: string | null
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
    audience?: DocAudience
    parentId?: string | null
    position?: number
    featured?: boolean
    status?: DocStatus
    kind?: DocKind
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
    'id' | 'audience' | 'parentId' | 'position' | 'featured' | 'status' | 'kind' | 'replacementSlug'
  > & {
    id: string
    audience: DocAudience
    parentId: string | null
    position: number
    featured: boolean
    status: DocStatus
    kind: DocKind
    replacementSlug: string | null
  }
  revisions: Array<
    Omit<
      RecordDocImportInput['revisions'][number],
      'audience' | 'parentId' | 'position' | 'featured' | 'status' | 'kind' | 'replacementSlug'
    > & {
      audience: DocAudience
      parentId: string | null
      position: number
      featured: boolean
      status: DocStatus
      kind: DocKind
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
      audience: input.doc.audience ?? 'technical',
      parentId: input.doc.parentId ?? null,
      position: input.doc.position ?? 0,
      featured: input.doc.featured ?? false,
      status: input.doc.status ?? 'current',
      kind: input.doc.kind ?? 'working',
      replacementSlug: input.doc.replacementSlug ?? null,
    },
    revisions: input.revisions.map((revision) => ({
      ...revision,
      audience: revision.audience ?? 'technical',
      parentId: revision.parentId ?? null,
      position: revision.position ?? 0,
      featured: revision.featured ?? false,
      status: revision.status ?? 'current',
      kind: revision.kind ?? 'working',
      replacementSlug: revision.replacementSlug ?? null,
    })),
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
  value == null ? null : new Date(String(value)).toISOString()

export function recordDocRow(row: Record<string, unknown>): RecordDoc {
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
    audience: String(row.audience) as DocAudience,
    parentId: row.parent_id == null ? null : String(row.parent_id),
    position: Number(row.position),
    featured: row.featured == null ? false : Boolean(row.featured),
    status: (row.status == null ? 'current' : String(row.status)) as DocStatus,
    kind: (row.kind == null ? 'working' : String(row.kind)) as DocKind,
    replacementSlug: row.replacement_slug == null ? null : String(row.replacement_slug),
    summary: docSummary(String(row.body)),
    projectName: row.project_name == null ? null : String(row.project_name),
    createdAt: recordDocIso(row.created_at)!,
    updatedAt: recordDocIso(row.updated_at)!,
    deletedAt: recordDocIso(row.deleted_at),
  }
}

export function recordDocRevisionRow(row: Record<string, unknown>): RecordDocRevision {
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
    delivery: String(row.delivery) as DocDelivery,
    audience: String(row.audience) as DocAudience,
    parentId: row.parent_id == null ? null : String(row.parent_id),
    position: Number(row.position),
    featured: row.featured == null ? false : Boolean(row.featured),
    status: (row.status == null ? 'current' : String(row.status)) as DocStatus,
    kind: (row.kind == null ? 'working' : String(row.kind)) as DocKind,
    replacementSlug: row.replacement_slug == null ? null : String(row.replacement_slug),
    author: String(row.author),
    reason: String(row.reason),
    sessionId: row.session_id == null ? null : String(row.session_id),
    at: recordDocIso(row.at)!,
  }
}
