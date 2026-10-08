/** Owns local document list queries. Must not know hosted transport, canon files, or CLI. */
import type { Database } from 'bun:sqlite'
import {
  DOC_AUDIENCES,
  DOC_KINDS,
  DOC_SCOPES,
  DOC_STATUSES,
  type DocAudience,
  type DocKind,
  type DocScope,
  type DocStatus,
} from '../../../shared/docs.ts'
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
  audience: DocAudience
  featured: boolean
  status: DocStatus
  kind: DocKind
  replacement_slug: string | null
  parent_id: number | null
  parent_slug: string | null
  position: number
  created_at: string
  updated_at: string
  record_id: string | null
  revision: string | null
}
export type DocMetadata = Pick<
  Doc,
  | 'id'
  | 'scope'
  | 'subject'
  | 'slug'
  | 'title'
  | 'audience'
  | 'featured'
  | 'status'
  | 'kind'
  | 'replacement_slug'
  | 'parent_id'
  | 'parent_slug'
  | 'position'
  | 'updated_at'
  | 'revision'
> & { bytes: number }
export type DocListFilters = {
  scope?: string
  subject?: string | null
  scopes?: string[]
  match?: string
  bodyMatch?: string
  updatedAtOrder?: 'asc' | 'desc'
  owner?: string | null
  audience?: string
  status?: string
  kind?: string
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
  audience: DocAudience
  featured: boolean
  status: DocStatus
  kind: DocKind
  replacement_slug: string | null
  parent_id: number | null
  position: number
  author: string
  reason: string
  session_id: string | null
  at: string
  record_id: string | null
}
export type DocRevisionMetadata = Pick<
  DocRevision,
  'id' | 'op' | 'author' | 'reason' | 'at' | 'status' | 'kind' | 'replacement_slug' | 'record_id'
> & { bytes: number }

const LATEST_REVISION_SQL =
  '(SELECT r.record_id FROM doc_revision r WHERE r.doc_id=d.id ORDER BY r.id DESC LIMIT 1)'

const docRow = <T extends { featured: boolean | number }>(row: T): T => ({
  ...row,
  featured: Boolean(row.featured),
})

function treeColumns(database: Database): boolean {
  return Boolean(
    database.query("SELECT 1 FROM pragma_table_info('doc') WHERE name='audience'").get(),
  )
}

function statusColumns(database: Database): boolean {
  return Boolean(database.query("SELECT 1 FROM pragma_table_info('doc') WHERE name='status'").get())
}

function kindColumns(database: Database): boolean {
  return Boolean(database.query("SELECT 1 FROM pragma_table_info('doc') WHERE name='kind'").get())
}

function docTreeSelect(database: Database): { columns: string; join: string; position: string } {
  const status = statusColumns(database) ? '' : ", 'current' AS status, NULL AS replacement_slug"
  const kind = kindColumns(database) ? '' : ", 'working' AS kind"
  return treeColumns(database)
    ? {
        columns: `d.*, p.slug AS parent_slug${status}${kind}`,
        join: ' LEFT JOIN doc p ON p.id=d.parent_id',
        position: 'd.position',
      }
    : {
        columns: `d.*, 'technical' AS audience, 0 AS featured, NULL AS parent_id, NULL AS parent_slug, 0 AS position${status}${kind}`,
        join: '',
        position: '0+0',
      }
}

function validScope(scope: string): void {
  if (!DOC_SCOPES.includes(scope as DocScope)) {
    throw new Error(`unknown doc scope "${scope}"; valid scopes: ${DOC_SCOPES.join(', ')}`)
  }
}

function validAudience(audience: string): asserts audience is DocAudience {
  if (!DOC_AUDIENCES.includes(audience as DocAudience)) {
    throw new Error(
      `unknown doc audience "${audience}"; valid audiences: ${DOC_AUDIENCES.join(', ')}`,
    )
  }
}

function validStatus(status: string): asserts status is DocStatus {
  if (!DOC_STATUSES.includes(status as DocStatus)) {
    throw new Error(`unknown doc status "${status}"; valid statuses: ${DOC_STATUSES.join(', ')}`)
  }
}

function validKind(kind: string): asserts kind is DocKind {
  if (!DOC_KINDS.includes(kind as DocKind)) {
    throw new Error(`unknown doc kind "${kind}"; valid kinds: ${DOC_KINDS.join(', ')}`)
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
    where.push('d.scope = ?')
    values.push(filters.scope)
  }
  if (filters.subject !== undefined) {
    where.push(filters.subject === null ? 'd.subject IS NULL' : 'd.subject = ?')
    if (filters.subject !== null) values.push(filters.subject)
  }
  if (filters.owner !== undefined) {
    where.push(filters.owner === null ? 'd.owner IS NULL' : 'd.owner = ?')
    if (filters.owner !== null) values.push(filters.owner)
  } else where.push('d.owner IS NULL')
  return { where, values }
}

export function getDocStore(
  scope: string,
  subject: string | null,
  slug: string,
  owner: string | null = null,
  database: Database = db(),
): Doc | null {
  validScope(scope)
  const tree = docTreeSelect(database)
  const row = database
    .query(
      `SELECT ${tree.columns}, ${LATEST_REVISION_SQL} AS revision FROM doc d${tree.join} WHERE d.scope=? AND d.subject IS ? AND d.owner IS ? AND d.slug=?`,
    )
    .get(scope, subject, owner, slug) as (Doc & { featured: boolean | number }) | null
  return row ? docRow(row) : null
}

export function listDocsStore(
  filters: {
    scope?: string
    subject?: string | null
    owner?: string | null
    audience?: string
    status?: string
    kind?: string
  } = {},
  database: Database = db(),
): Doc[] {
  const { where, values } = addressFilters(filters)
  const tree = docTreeSelect(database)
  if (filters.audience !== undefined) {
    validAudience(filters.audience)
    if (treeColumns(database)) {
      where.push('d.audience = ?')
      values.push(filters.audience)
    } else if (filters.audience === 'user') where.push('0')
  }
  if (filters.status !== undefined) {
    validStatus(filters.status)
    if (statusColumns(database)) {
      where.push('d.status = ?')
      values.push(filters.status)
    } else if (filters.status !== 'current') where.push('0')
  }
  if (filters.kind !== undefined) {
    validKind(filters.kind)
    if (kindColumns(database)) {
      where.push('d.kind = ?')
      values.push(filters.kind)
    } else if (filters.kind !== 'working') where.push('0')
  }
  return (
    database
      .query(
        `SELECT ${tree.columns}, ${LATEST_REVISION_SQL} AS revision FROM doc d${tree.join}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ` +
          `ORDER BY d.scope, COALESCE(d.subject, ''), ${tree.position}, d.title`,
      )
      .all(...values) as Array<Doc & { featured: boolean | number }>
  ).map(docRow)
}

export function listDocMetadataStore(filters: DocListFilters = {}): DocMetadata[] {
  if (filters.scopes !== undefined) {
    for (const scope of filters.scopes) validScope(scope)
  }
  if (filters.scope !== undefined && filters.scopes !== undefined) {
    throw new Error('use scope or scopes, not both')
  }
  const { where, values } = addressFilters(filters)
  if (filters.audience !== undefined) {
    validAudience(filters.audience)
    where.push('d.audience = ?')
    values.push(filters.audience)
  }
  if (filters.status !== undefined) {
    validStatus(filters.status)
    where.push('d.status = ?')
    values.push(filters.status)
  }
  if (filters.kind !== undefined) {
    validKind(filters.kind)
    where.push('d.kind = ?')
    values.push(filters.kind)
  }
  if (filters.scopes !== undefined) {
    if (filters.scopes.length === 0) where.push('0')
    else {
      where.push(`d.scope IN (${filters.scopes.map(() => '?').join(', ')})`)
      values.push(...filters.scopes)
    }
  }
  if (filters.match !== undefined) {
    where.push(`(
      instr(lower(d.title), lower(?)) > 0 OR
      instr(lower(d.slug), lower(?)) > 0 OR
      instr(lower(COALESCE(d.subject, '')), lower(?)) > 0
    )`)
    values.push(filters.match, filters.match, filters.match)
  }
  if (filters.bodyMatch !== undefined) {
    where.push('instr(lower(d.body), lower(?)) > 0')
    values.push(filters.bodyMatch)
  }
  const order = filters.updatedAtOrder
    ? `d.updated_at ${filters.updatedAtOrder.toUpperCase()}, d.scope, COALESCE(d.subject, ''), d.position, d.title`
    : "d.scope, COALESCE(d.subject, ''), d.position, d.title"
  return (
    db()
      .query(
        `SELECT d.id, d.scope, d.subject, d.slug, d.title, d.audience, d.featured, d.status, d.kind, d.replacement_slug, d.parent_id, p.slug AS parent_slug, d.position, length(CAST(d.body AS BLOB)) AS bytes, d.updated_at, ${LATEST_REVISION_SQL} AS revision
       FROM doc d LEFT JOIN doc p ON p.id=d.parent_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`,
      )
      .all(...values) as Array<DocMetadata & { featured: boolean | number }>
  ).map(docRow)
}
