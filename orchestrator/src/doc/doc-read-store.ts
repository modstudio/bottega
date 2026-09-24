/** Owns local document list queries. Must not know hosted transport, canon files, or CLI. */
import { DOC_SCOPES, type DocScope } from '../../../shared/docs.ts'
import { db } from '../database/db.ts'
import type { DocRevisionOp } from './doc-write-allowed.ts'

export type Doc = {
  id: number
  scope: DocScope
  subject: string | null
  owner: string | null
  project_id: number | null
  slug: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
  created_at: string
  updated_at: string
  record_id: string | null
  revision: string | null
}
export type DocMetadata = Pick<
  Doc,
  'id' | 'scope' | 'subject' | 'slug' | 'title' | 'updated_at' | 'revision'
> & { bytes: number }
export type DocListFilters = {
  scope?: string
  subject?: string | null
  scopes?: string[]
  match?: string
  bodyMatch?: string
  updatedAtOrder?: 'asc' | 'desc'
  owner?: string | null
}

export type DocRevision = {
  id: number
  doc_id: number
  scope: DocScope
  subject: string | null
  owner: string | null
  project_id: number | null
  slug: string
  op: DocRevisionOp
  title: string
  body: string
  delivery: 'inject' | 'demand'
  author: string
  reason: string
  session_id: string | null
  at: string
  record_id: string | null
}
export type DocRevisionMetadata = Omit<
  DocRevision,
  'title' | 'body' | 'delivery' | 'session_id' | 'doc_id' | 'scope' | 'subject' | 'slug'
> & { bytes: number }

const LATEST_REVISION_SQL =
  '(SELECT r.record_id FROM doc_revision r WHERE r.doc_id=d.id ORDER BY r.id DESC LIMIT 1)'

function validScope(scope: string): void {
  if (!DOC_SCOPES.includes(scope as DocScope)) {
    throw new Error(`unknown doc scope "${scope}"; valid scopes: ${DOC_SCOPES.join(', ')}`)
  }
}

function addressFilters(filters: {
  scope?: string
  subject?: string | null
  owner?: string | null
}): { where: string[]; values: string[] } {
  const where: string[] = []
  const values: string[] = []
  if (filters.scope !== undefined) {
    validScope(filters.scope)
    where.push('scope = ?')
    values.push(filters.scope)
  }
  if (filters.subject !== undefined) {
    where.push(filters.subject === null ? 'subject IS NULL' : 'subject = ?')
    if (filters.subject !== null) values.push(filters.subject)
  }
  if (filters.owner !== undefined) {
    where.push(filters.owner === null ? 'owner IS NULL' : 'owner = ?')
    if (filters.owner !== null) values.push(filters.owner)
  } else where.push('owner IS NULL')
  return { where, values }
}

export function listDocsStore(
  filters: { scope?: string; subject?: string | null; owner?: string | null } = {},
): Doc[] {
  const { where, values } = addressFilters(filters)
  return db()
    .query(
      `SELECT d.*, ${LATEST_REVISION_SQL} AS revision FROM doc d${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ` +
        "ORDER BY scope, COALESCE(subject, ''), slug",
    )
    .all(...values) as Doc[]
}

export function listDocMetadataStore(filters: DocListFilters = {}): DocMetadata[] {
  if (filters.scopes !== undefined) {
    for (const scope of filters.scopes) validScope(scope)
  }
  if (filters.scope !== undefined && filters.scopes !== undefined) {
    throw new Error('use scope or scopes, not both')
  }
  const { where, values } = addressFilters(filters)
  if (filters.scopes !== undefined) {
    if (filters.scopes.length === 0) where.push('0')
    else {
      where.push(`scope IN (${filters.scopes.map(() => '?').join(', ')})`)
      values.push(...filters.scopes)
    }
  }
  if (filters.match !== undefined) {
    where.push(`(
      instr(lower(title), lower(?)) > 0 OR
      instr(lower(slug), lower(?)) > 0 OR
      instr(lower(COALESCE(subject, '')), lower(?)) > 0
    )`)
    values.push(filters.match, filters.match, filters.match)
  }
  if (filters.bodyMatch !== undefined) {
    where.push('instr(lower(body), lower(?)) > 0')
    values.push(filters.bodyMatch)
  }
  const order = filters.updatedAtOrder
    ? `updated_at ${filters.updatedAtOrder.toUpperCase()}, scope, COALESCE(subject, ''), slug`
    : "scope, COALESCE(subject, ''), slug"
  return db()
    .query(
      `SELECT d.id, d.scope, d.subject, d.slug, d.title, length(CAST(d.body AS BLOB)) AS bytes, d.updated_at, ${LATEST_REVISION_SQL} AS revision
       FROM doc d${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`,
    )
    .all(...values) as DocMetadata[]
}
