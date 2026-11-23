import type { DocKind, DocStatus } from '../../../shared/docs.ts'
import type { RecordApiClient } from '../../src/record/record-api-client.ts'
import {
  type RecordDoc,
  type RecordDocRevision,
  recordDocRow,
} from '../../src/record/record-doc-mapping.ts'

export type StoredDoc = {
  id: string
  scope: string
  subject: string | null
  owner: string | null
  slug: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
  status: DocStatus
  kind: DocKind
  projectName: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
  latestRevisionId: string | null
}

export type StoredRevision = Pick<
  RecordDocRevision,
  | 'id'
  | 'docId'
  | 'scope'
  | 'subject'
  | 'slug'
  | 'op'
  | 'title'
  | 'body'
  | 'delivery'
  | 'author'
  | 'reason'
  | 'at'
>

export function hostedStoredDoc(doc: StoredDoc): RecordDoc {
  return recordDocRow({
    id: doc.id,
    space_id: '01990000-0000-7000-8000-000000000002',
    space_name: 'Fixture',
    scope: doc.scope,
    subject: doc.subject,
    owner_user_id: doc.owner,
    slug: doc.slug,
    title: doc.title,
    body: doc.body,
    delivery: doc.delivery,
    audiences: ['technical'],
    parent_id: null,
    position: 0,
    featured: false,
    status: doc.status,
    kind: doc.kind,
    form: null,
    article_subject_id: null,
    related_subjects: [],
    source_files: [],
    checked_against_commit: null,
    replacement_slug: null,
    summary: null,
    project_name: doc.projectName,
    latest_revision_id: doc.latestRevisionId,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
    deleted_at: doc.deletedAt,
  })
}

export function hostedStoredRevision(
  revision: StoredRevision,
  doc: StoredDoc | undefined,
): RecordDocRevision {
  return {
    ...revision,
    owner: doc?.owner ?? null,
    withheldForAudience: false,
    audiences: ['technical'],
    parentId: null,
    position: 0,
    featured: false,
    status: doc?.status ?? 'current',
    kind: doc?.kind ?? 'working',
    form: null,
    articleSubject: null,
    relatedSubjects: [],
    sourceFiles: [],
    checkedAgainstCommit: null,
    summary: null,
    replacementSlug: null,
    authorName: null,
    sessionId: null,
  }
}

type DocQuery = Parameters<RecordApiClient['listDocs']>[0]

function matchesClassification(query: DocQuery, doc: StoredDoc): boolean {
  if (query.status !== undefined && doc.status !== query.status) return false
  if (query.kind !== undefined && doc.kind !== query.kind) return false
  return true
}

export function matchesStoredDoc(query: DocQuery, doc: StoredDoc): boolean {
  if (query.scope && doc.scope !== query.scope) return false
  if (query.subject !== undefined && doc.subject !== query.subject) return false
  if (query.slug !== undefined && doc.slug !== query.slug) return false
  if (query.owner !== undefined && doc.owner !== query.owner) return false
  if (!matchesClassification(query, doc)) return false
  if (!query.includeDeleted && doc.deletedAt) return false
  if (query.updatedSince && doc.updatedAt <= query.updatedSince) return false
  return true
}
