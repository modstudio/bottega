// concern: record-public-docs
/** Owns public-role document reads and hosted document search. Must not know HTTP or sessions. */
import { SQL } from 'bun'
import { docBodyForAudience } from '../../../shared/doc-sections.ts'
import {
  type DocAudience,
  type DocAudiences,
  type DocStatus,
  docSummary,
} from '../../../shared/docs.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { recordDocAudiences } from './record-doc-audiences.ts'

const DOC_SEARCH_RESULT_LIMIT = 20

type Tenant = { url: string } & TenantPrincipal

export type PublicRecordDoc = {
  id: string
  slug: string
  title: string
  body: string
  parentId: string | null
  position: number
  updatedAt: string
  scope: string
  subject: string | null
  audiences: DocAudiences
  summary?: string
  featured?: boolean
}

export type PublicRecordDocTreeItem = Omit<PublicRecordDoc, 'body'>

export type RecordDocSearchMatch = {
  id: string
  slug: string
  title: string
  snippet: string
  spaceName?: string
  status: DocStatus
  audiences: DocAudiences
}

export type RecordDocSearchInput = {
  query: string
  scope?: string
  subject?: string | null
  audience?: DocAudience
  acrossReadableSpaces: boolean
  includeDrafts?: boolean
}

export function normalizeDocSearchQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

const iso = (value: unknown) => new Date(String(value)).toISOString()

export function publicRecordDocRow(
  row: Record<string, unknown>,
  audience?: DocAudience,
): PublicRecordDoc {
  const storedBody = String(row.body)
  const body = audience ? docBodyForAudience(storedBody, audience) : storedBody
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    body,
    parentId: row.parent_id == null ? null : String(row.parent_id),
    position: Number(row.position),
    updatedAt: iso(row.updated_at),
    scope: String(row.scope),
    subject: row.subject == null ? null : String(row.subject),
    audiences: recordDocAudiences(row.audiences),
    summary: docSummary(body),
    featured: row.featured == null ? false : Boolean(row.featured),
  }
}

export function recordDocSearchMatchRow(row: Record<string, unknown>): RecordDocSearchMatch {
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    snippet: String(row.snippet),
    status: (row.status == null ? 'current' : String(row.status)) as DocStatus,
    audiences: recordDocAudiences(row.audiences),
    ...(row.space_name == null ? {} : { spaceName: String(row.space_name) }),
  }
}

async function publicRead<T>(url: string, read: (tx: SQL) => Promise<T>): Promise<T> {
  const client = new SQL(url)
  try {
    return await client.begin(async (tx) => {
      await tx.unsafe('SET LOCAL ROLE record_public')
      return read(tx)
    })
  } finally {
    await client.close()
  }
}

async function tenantRead<T>(input: Tenant, read: (tx: SQL) => Promise<T>): Promise<T> {
  const client = new SQL(input.url)
  try {
    return await client.begin(async (tx) => {
      await bindTenant(tx, input)
      return read(tx)
    })
  } finally {
    await client.close()
  }
}

export async function listPublicRecordDocs(input: {
  url: string
}): Promise<PublicRecordDocTreeItem[]> {
  return publicRead(input.url, async (tx) => {
    const rows = await tx`
      SELECT id, slug, title, body, featured, parent_id, position, updated_at, scope, subject, audiences
      FROM doc
      ORDER BY position, title, id
    `
    return rows.map((row: Record<string, unknown>) => {
      const { body: _body, ...item } = publicRecordDocRow(row, 'customer')
      return item
    })
  })
}

export async function getPublicRecordDoc(input: {
  url: string
  id: string
}): Promise<PublicRecordDoc | null> {
  return publicRead(input.url, async (tx) => {
    const rows = await tx`
      SELECT id, slug, title, body, featured, parent_id, position, updated_at, scope, subject, audiences
      FROM doc
      WHERE id=${input.id}::uuid
    `
    return rows[0] ? publicRecordDocRow(rows[0] as Record<string, unknown>, 'customer') : null
  })
}

async function searchedRows(
  tx: SQL,
  rows: Record<string, unknown>[],
  query: string,
  audience: DocAudience | undefined,
): Promise<Record<string, unknown>[]> {
  const matched: Record<string, unknown>[] = []
  for (const row of rows) {
    const body = audience ? docBodyForAudience(String(row.body), audience) : String(row.body)
    const search = await tx`
      SELECT ts_headline('english', ${body}, websearch_to_tsquery('english', ${query})) AS snippet,
             ts_rank(
               setweight(to_tsvector('english', ${String(row.title)}), 'A') ||
               setweight(to_tsvector('english', ${body}), 'B'),
               websearch_to_tsquery('english', ${query})
             ) AS rank
      WHERE (
        setweight(to_tsvector('english', ${String(row.title)}), 'A') ||
        setweight(to_tsvector('english', ${body}), 'B')
      ) @@ websearch_to_tsquery('english', ${query})
    `
    if (search[0]) matched.push({ ...row, ...search[0] })
  }
  return matched
    .sort(
      (left, right) =>
        Number(right.rank) - Number(left.rank) ||
        String(right.updated_at).localeCompare(String(left.updated_at)) ||
        String(left.id).localeCompare(String(right.id)),
    )
    .slice(0, DOC_SEARCH_RESULT_LIMIT)
}

export async function searchPublicRecordDocs(input: {
  url: string
  query: string
}): Promise<RecordDocSearchMatch[]> {
  const query = normalizeDocSearchQuery(input.query)
  if (!query) return []
  return publicRead(input.url, async (tx) => {
    const rows = (await tx`
      SELECT d.id, d.slug, d.title, d.body, d.audiences, d.updated_at, 'current' AS status
      FROM doc d WHERE d.status = 'current'
    `) as Record<string, unknown>[]
    return (await searchedRows(tx, rows, query, 'customer')).map(recordDocSearchMatchRow)
  })
}

export async function searchRecordDocs(
  input: Tenant & RecordDocSearchInput,
): Promise<RecordDocSearchMatch[]> {
  const query = normalizeDocSearchQuery(input.query)
  if (!query) return []
  return tenantRead(input, async (tx) => {
    const spaceIds = input.spaceIds?.length ? input.spaceIds : [input.spaceId]
    const selectedSpaceIds = input.acrossReadableSpaces ? spaceIds : [input.spaceId]
    const rows = (await tx`
        SELECT d.id, d.slug, d.title, d.body, d.status, d.audiences, d.updated_at, s.name AS space_name
        FROM doc d
        JOIN space s ON s.id=d.space_id
        WHERE d.space_id = ANY(string_to_array(${selectedSpaceIds.join(',')}, ',')::uuid[])
          AND d.deleted_at IS NULL
          AND (${input.scope ?? null}::text IS NULL OR d.scope=${input.scope ?? null})
          AND (${input.audience ?? null}::text IS NULL OR ${input.audience ?? null}=ANY(d.audiences))
          AND (
            ${input.subject === undefined}::boolean
            OR (${input.subject === null}::boolean AND d.subject IS NULL)
            OR d.subject=${input.subject ?? null}
          )
          AND (d.status = 'current' OR (${input.includeDrafts ?? false}::boolean AND d.status = 'draft'))
    `) as Record<string, unknown>[]
    return (await searchedRows(tx, rows, query, input.audience)).map(recordDocSearchMatchRow)
  })
}
