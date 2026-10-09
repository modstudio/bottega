// concern: record-public-docs
/** Owns public-role document reads and hosted document search. Must not know HTTP or sessions. */
import { SQL } from 'bun'
import { type DocAudience, type DocStatus, docSummary } from '../../../shared/docs.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'

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

export function publicRecordDocRow(row: Record<string, unknown>): PublicRecordDoc {
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    body: String(row.body),
    parentId: row.parent_id == null ? null : String(row.parent_id),
    position: Number(row.position),
    updatedAt: iso(row.updated_at),
    scope: String(row.scope),
    subject: row.subject == null ? null : String(row.subject),
    summary: docSummary(String(row.body)),
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
      SELECT id, slug, title, body, featured, parent_id, position, updated_at, scope, subject
      FROM doc
      ORDER BY position, title, id
    `
    return rows.map((row: Record<string, unknown>) => {
      const { body: _body, ...item } = publicRecordDocRow(row)
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
      SELECT id, slug, title, body, featured, parent_id, position, updated_at, scope, subject
      FROM doc
      WHERE id=${input.id}::uuid
    `
    return rows[0] ? publicRecordDocRow(rows[0] as Record<string, unknown>) : null
  })
}

export async function searchPublicRecordDocs(input: {
  url: string
  query: string
}): Promise<RecordDocSearchMatch[]> {
  const query = normalizeDocSearchQuery(input.query)
  if (!query) return []
  return publicRead(input.url, async (tx) => {
    const rows = await tx`
      WITH search_query AS (
        SELECT websearch_to_tsquery('english', ${query}) AS value
      ), limited AS (
        SELECT d.id, d.slug, d.title, d.body, q.value,
               ts_rank(d.search_vector, q.value) AS rank
        FROM doc d
        CROSS JOIN search_query q
        WHERE d.status = 'current' AND d.search_vector @@ q.value
        ORDER BY rank DESC, d.updated_at DESC, d.id
        LIMIT ${DOC_SEARCH_RESULT_LIMIT}
      )
      SELECT id, slug, title, 'current' AS status, ts_headline('english', body, value) AS snippet, rank
      FROM limited
      ORDER BY rank DESC, id
    `
    return rows.map((row: Record<string, unknown>) => recordDocSearchMatchRow(row))
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
    const rows = await tx`
      WITH search_query AS (
        SELECT websearch_to_tsquery('english', ${query}) AS value
      ), limited AS (
        SELECT d.id, d.slug, d.title, d.body, d.status, s.name AS space_name, q.value,
               ts_rank(d.search_vector, q.value) AS rank
        FROM doc d
        JOIN space s ON s.id=d.space_id
        CROSS JOIN search_query q
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
          AND d.search_vector @@ q.value
        ORDER BY rank DESC, d.updated_at DESC, d.id
        LIMIT ${DOC_SEARCH_RESULT_LIMIT}
      )
      SELECT id, slug, title, status, space_name,
             ts_headline('english', body, value) AS snippet, rank
      FROM limited
      ORDER BY rank DESC, id
    `
    return rows.map((row: Record<string, unknown>) => recordDocSearchMatchRow(row))
  })
}
