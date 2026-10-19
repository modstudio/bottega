/** Owns local document list queries. Must not know hosted transport, canon files, or CLI. */
import type { Database } from 'bun:sqlite'
import { docAudienceRefusal, docBodyForAudience } from '../../../shared/doc-sections.ts'
import {
  DOC_AUDIENCES,
  DOC_KINDS,
  DOC_SCOPES,
  DOC_STATUSES,
  type DocArticleSubject,
  type DocAudience,
  type DocAudiences,
  type DocForm,
  type DocKind,
  type DocScope,
  type DocStatus,
  effectiveDocSummary,
} from '../../../shared/docs.ts'
import { db } from '../database/db.ts'
import { decodeStoredDocAudiences } from './doc-audiences-codec.ts'
import type { DocRevisionOp } from './doc-write-allowed.ts'

export type Doc = {
  record_id: string
  scope: DocScope
  subject: string | null
  owner: string | null
  project_record_id: string | null
  slug: string
  title: string
  body: string
  delivery: 'inject' | 'demand'
  audiences: DocAudiences
  featured: boolean
  status: DocStatus
  kind: DocKind
  form: DocForm | null
  article_subject_id: string | null
  articleSubject: DocArticleSubject | null
  relatedSubjects: DocArticleSubject[]
  sourceFiles: string[]
  checkedAgainstCommit: string | null
  summary: string | null
  replacement_slug: string | null
  parent_record_id: string | null
  parent_slug: string | null
  position: number
  created_at: string
  updated_at: string
  revision: string | null
}
export type DocMetadata = Pick<
  Doc,
  | 'record_id'
  | 'scope'
  | 'subject'
  | 'slug'
  | 'title'
  | 'audiences'
  | 'featured'
  | 'status'
  | 'kind'
  | 'form'
  | 'articleSubject'
  | 'relatedSubjects'
  | 'sourceFiles'
  | 'checkedAgainstCommit'
  | 'summary'
  | 'replacement_slug'
  | 'parent_record_id'
  | 'parent_slug'
  | 'position'
  | 'updated_at'
  | 'revision'
> & { bytes: number; summarySource: 'written' | 'derived' }
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
  articleSubject?: string
}

export type DocRevision = {
  record_id: string
  number: number
  doc_record_id: string | null
  scope: DocScope
  subject: string | null
  owner: string | null
  project_record_id: string | null
  slug: string
  op: DocRevisionOp
  title: string
  body: string
  delivery: 'inject' | 'demand'
  audiences: DocAudiences
  featured: boolean
  status: DocStatus
  kind: DocKind
  form: DocForm | null
  article_subject_id: string | null
  articleSubject: DocArticleSubject | null
  relatedSubjects: DocArticleSubject[]
  sourceFiles: string[]
  checkedAgainstCommit: string | null
  summary: string | null
  replacement_slug: string | null
  parent_record_id: string | null
  position: number
  author: string
  reason: string
  session_id: string | null
  at: string
}
export type DocRevisionMetadata = Pick<
  DocRevision,
  | 'number'
  | 'op'
  | 'author'
  | 'reason'
  | 'at'
  | 'status'
  | 'kind'
  | 'replacement_slug'
  | 'record_id'
  | 'form'
  | 'articleSubject'
  | 'relatedSubjects'
  | 'sourceFiles'
  | 'checkedAgainstCommit'
  | 'summary'
> & { bytes: number }

const LATEST_REVISION_SQL =
  '(SELECT r.record_id FROM doc_revision r WHERE r.doc_record_id=d.record_id ORDER BY r.number DESC LIMIT 1)'

const articleFields = (
  database: Database,
  row: {
    kind?: string
    record_id?: string | null
    article_subject_id?: string | null
    source_files?: string
    checked_against_commit?: string | null
  },
) => {
  const own = row.article_subject_id
    ? (database
        .query<{ id: string; name: string }, [string]>('SELECT id,name FROM subject WHERE id=?')
        .get(row.article_subject_id) ?? null)
    : null
  // Only an article can hold related subjects, so no other document reads the link table.
  const related =
    row.kind === 'article' && row.record_id
      ? database
          .query<{ id: string; name: string }, [string]>(
            `SELECT s.id,s.name FROM doc_related_subject r JOIN subject s ON s.id=r.subject_id WHERE r.doc_record_id=? ORDER BY s.position,s.id`,
          )
          .all(row.record_id)
      : []
  return {
    articleSubject: own,
    relatedSubjects: related,
    sourceFiles: JSON.parse(row.source_files ?? '[]') as string[],
    checkedAgainstCommit:
      row.checked_against_commit == null ? null : String(row.checked_against_commit),
  }
}

const docRow = <
  T extends {
    featured: boolean | number
    audiences: string | DocAudiences
    record_id?: string | null
    article_subject_id?: string | null
    source_files?: string
    checked_against_commit?: string | null
  },
>(
  database: Database,
  row: T,
) => ({
  ...row,
  ...articleFields(database, row),
  featured: Boolean(row.featured),
  audiences:
    typeof row.audiences === 'string' ? decodeStoredDocAudiences(row.audiences) : row.audiences,
})

function treeColumns(database: Database): boolean {
  return Boolean(
    database.query("SELECT 1 FROM pragma_table_info('doc') WHERE name='audiences'").get(),
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
        join: ' LEFT JOIN doc p ON p.record_id=d.parent_record_id',
        position: 'd.position',
      }
    : {
        columns: `d.*, '["technical"]' AS audiences, 0 AS featured, NULL AS parent_record_id, NULL AS parent_slug, 0 AS position${status}${kind}`,
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
  return row ? docRow(database, row) : null
}

export function getDocForAudienceStore(
  scope: string,
  subject: string | null,
  slug: string,
  audience: DocAudience,
  owner: string | null = null,
  database: Database = db(),
): Doc | null {
  const doc = getDocStore(scope, subject, slug, owner, database)
  if (!doc) return null
  return docForAudience(doc, audience, `${scope}/${subject ?? '_'}/${slug}`)
}

export function docForAudience<T extends { audiences: DocAudiences; body: string }>(
  doc: T,
  audience: DocAudience,
  address: string,
): T {
  const refusal = docAudienceRefusal(address, doc.audiences, audience)
  if (refusal) throw new Error(refusal)
  return { ...doc, body: docBodyForAudience(doc.body, audience) }
}

export function listDocsStore(
  filters: {
    scope?: string
    subject?: string | null
    owner?: string | null
    audience?: string
    status?: string
    kind?: string
    articleSubject?: string
  } = {},
  database: Database = db(),
): Doc[] {
  const { where, values } = addressFilters(filters)
  const tree = docTreeSelect(database)
  if (filters.audience !== undefined) {
    validAudience(filters.audience)
    if (treeColumns(database)) {
      where.push('EXISTS (SELECT 1 FROM json_each(d.audiences) WHERE value = ?)')
      values.push(filters.audience)
    } else if (filters.audience !== 'technical') where.push('0')
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
  const articleQuery = articleSubjectQuery(filters.articleSubject, where, values)
  return (
    database
      .query(
        `SELECT ${tree.columns}, ${LATEST_REVISION_SQL} AS revision FROM doc d${tree.join}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ` +
          `ORDER BY ${articleQuery.order}d.scope, COALESCE(d.subject, ''), ${tree.position}, d.title`,
      )
      .all(...articleQuery.values) as Array<Doc & { featured: boolean | number }>
  )
    .map((row) => docRow(database, row))
    .map((doc) =>
      filters.audience
        ? { ...doc, body: docBodyForAudience(doc.body, filters.audience as DocAudience) }
        : doc,
    )
}

function articleSubjectQuery(
  articleSubject: string | undefined,
  where: string[],
  values: string[],
): { order: string; values: string[] } {
  if (articleSubject === undefined) return { order: '', values }
  where.push(
    '(d.article_subject_id = ? OR EXISTS (SELECT 1 FROM doc_related_subject rs WHERE rs.doc_record_id=d.record_id AND rs.subject_id=?))',
  )
  values.push(articleSubject, articleSubject)
  return {
    order: 'CASE WHEN d.article_subject_id = ? THEN 0 ELSE 1 END, ',
    values: [...values, articleSubject],
  }
}

export function listDocMetadataStore(filters: DocListFilters = {}): DocMetadata[] {
  const projectedBodyMatch = filters.audience !== undefined && filters.bodyMatch !== undefined
  const { where, values } = metadataFilters(
    projectedBodyMatch ? { ...filters, bodyMatch: undefined } : filters,
  )
  const baseOrder = filters.updatedAtOrder
    ? `d.updated_at ${filters.updatedAtOrder.toUpperCase()}, d.scope, COALESCE(d.subject, ''), d.position, d.title`
    : "d.scope, COALESCE(d.subject, ''), d.position, d.title"
  const order =
    filters.articleSubject !== undefined
      ? `CASE WHEN d.article_subject_id = ? THEN 0 ELSE 1 END, ${baseOrder}`
      : baseOrder
  const queryValues =
    filters.articleSubject !== undefined ? [...values, filters.articleSubject] : values
  const rows = (
    db()
      .query(
        `SELECT d.record_id, d.scope, d.subject, d.slug, d.title, d.body, d.audiences, d.featured, d.status, d.kind, d.form, d.article_subject_id, d.source_files, d.checked_against_commit, d.summary, d.replacement_slug, d.parent_record_id, p.slug AS parent_slug, d.position, length(CAST(d.body AS BLOB)) AS bytes, d.updated_at, ${LATEST_REVISION_SQL} AS revision
       FROM doc d LEFT JOIN doc p ON p.record_id=d.parent_record_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order}`,
      )
      .all(...queryValues) as Array<
      Omit<DocMetadata, 'summarySource'> & { body: string; featured: boolean | number }
    >
  ).map((row) => {
    const doc = docRow(db(), row)
    const body = filters.audience
      ? docBodyForAudience(row.body, filters.audience as DocAudience)
      : row.body
    const { body: _body, ...metadata } = { ...doc, body: row.body }
    return { ...metadata, ...effectiveDocSummary(doc.summary, body) }
  })
  if (!projectedBodyMatch) return rows
  const needle = filters.bodyMatch!.toLocaleLowerCase()
  return rows.filter((row) => {
    const doc = getDocForAudienceStore(
      row.scope,
      row.subject,
      row.slug,
      filters.audience as DocAudience,
      filters.owner ?? null,
    )
    return doc?.body.toLocaleLowerCase().includes(needle)
  })
}

function metadataFilters(filters: DocListFilters): { where: string[]; values: string[] } {
  if (filters.scopes !== undefined) {
    for (const scope of filters.scopes) validScope(scope)
  }
  if (filters.scope !== undefined && filters.scopes !== undefined) {
    throw new Error('use scope or scopes, not both')
  }
  const { where, values } = addressFilters(filters)
  if (filters.articleSubject !== undefined) {
    where.push(
      '(d.article_subject_id = ? OR EXISTS (SELECT 1 FROM doc_related_subject rs WHERE rs.doc_record_id=d.record_id AND rs.subject_id=?))',
    )
    values.push(filters.articleSubject, filters.articleSubject)
  }
  if (filters.audience !== undefined) {
    validAudience(filters.audience)
    where.push('EXISTS (SELECT 1 FROM json_each(d.audiences) WHERE value = ?)')
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
  return { where, values }
}
