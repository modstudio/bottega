// concern: record-public-docs
/** Owns public-role document reads and hosted document search. Must not know HTTP or sessions. */
import { SQL } from 'bun'
import { docBodyForAudience } from '../../../shared/doc-sections.ts'
import {
  DOC_SNIPPET_START,
  DOC_SNIPPET_STOP,
  type DocSnippetHighlight,
  docPlainSnippet,
} from '../../../shared/doc-snippet.ts'
import {
  type DocAudience,
  type DocAudiences,
  type DocKind,
  type DocStatus,
  effectiveDocSummary,
} from '../../../shared/docs.ts'
import { bindTenant, type TenantPrincipal } from '../../../shared/record/tenant.ts'
import { recordDocAudiences } from './record-doc-audiences.ts'

const DOC_SEARCH_RESULT_LIMIT = 20
const TS_HEADLINE_OPTIONS = `StartSel=${DOC_SNIPPET_START}, StopSel=${DOC_SNIPPET_STOP}, HighlightAll=false, MaxFragments=1, MaxWords=30, MinWords=12`

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
  summarySource: 'written' | 'derived'
  featured?: boolean
  kind: DocKind
}

export type PublicRecordDocTreeItem = Omit<PublicRecordDoc, 'body'>

export type RecordDocSearchMatch = {
  id: string
  slug: string
  title: string
  snippet: string
  highlights: DocSnippetHighlight[]
  spaceName?: string
  status: DocStatus
  kind: DocKind
  audiences: DocAudiences
  summary: string
  summarySource: 'written' | 'derived'
}

export type RecordDocSearchInput = {
  query: string
  scope?: string
  subject?: string | null
  audience?: DocAudience
  acrossReadableSpaces: boolean
  includeDrafts?: boolean
  includeWorking?: boolean
}

export function normalizeDocSearchQuery(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

const iso = (value: unknown) => new Date(String(value)).toISOString()

export function publicRecordDocRow(row: Record<string, unknown>): PublicRecordDoc {
  const storedBody = String(row.body)
  const body = docBodyForAudience(storedBody, 'customer')
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
    ...effectiveDocSummary(row.summary == null ? null : String(row.summary), body),
    featured: row.featured == null ? false : Boolean(row.featured),
    kind: String(row.kind) as DocKind,
  }
}

export function recordDocSearchMatchRow(row: Record<string, unknown>): RecordDocSearchMatch {
  const { snippet, highlights } = docPlainSnippet(String(row.snippet))
  return {
    id: String(row.id),
    slug: String(row.slug),
    title: String(row.title),
    snippet,
    ...effectiveDocSummary(
      row.summary == null ? null : String(row.summary),
      String(row.body ?? ''),
    ),
    highlights,
    status: (row.status == null ? 'current' : String(row.status)) as DocStatus,
    kind: String(row.kind) as DocKind,
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
      SELECT id, slug, title, body, summary, featured, parent_id, position, updated_at, scope, subject, audiences, kind
      FROM doc
      WHERE kind = 'article'
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
      SELECT id, slug, title, body, summary, featured, parent_id, position, updated_at, scope, subject, audiences, kind
      FROM doc
      WHERE id=${input.id}::uuid AND kind = 'article'
    `
    return rows[0] ? publicRecordDocRow(rows[0] as Record<string, unknown>) : null
  })
}

function rankedRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows
    .sort(
      (left, right) =>
        Number(right.rank) - Number(left.rank) ||
        String(right.updated_at).localeCompare(String(left.updated_at)) ||
        String(left.id).localeCompare(String(right.id)),
    )
    .slice(0, DOC_SEARCH_RESULT_LIMIT)
}

async function searchedMarkedRows(
  tx: SQL,
  rows: Record<string, unknown>[],
  query: string,
  audience: DocAudience,
): Promise<Record<string, unknown>[]> {
  const matched: Record<string, unknown>[] = []
  for (const row of rows) {
    const body = docBodyForAudience(String(row.body), audience)
    const search = await tx`
      SELECT ts_headline('english', ${body}, websearch_to_tsquery('english', ${query}), ${TS_HEADLINE_OPTIONS}) AS snippet,
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
    if (search[0]) matched.push({ ...row, body, ...search[0] })
  }
  return matched
}

export async function searchPublicRecordDocs(input: {
  url: string
  query: string
}): Promise<RecordDocSearchMatch[]> {
  const query = normalizeDocSearchQuery(input.query)
  if (!query) return []
  return publicRead(input.url, async (tx) => {
    const unmarked = (await tx`
      WITH search_query AS (
        SELECT websearch_to_tsquery('english', ${query}) AS value
      ), limited AS (
        SELECT d.id, d.slug, d.title, d.body, d.summary, d.audiences, d.kind, d.updated_at, q.value,
               ts_rank(d.search_vector, q.value) AS rank
        FROM doc d
        CROSS JOIN search_query q
        WHERE d.status = 'current' AND d.kind = 'article'
          AND strpos(d.body, ':::section') = 0
          AND d.search_vector @@ q.value
        ORDER BY rank DESC, d.updated_at DESC, d.id
        LIMIT ${DOC_SEARCH_RESULT_LIMIT}
      )
      SELECT id, slug, title, body, summary, audiences, kind, updated_at, 'current' AS status,
             ts_headline('english', body, value, ${TS_HEADLINE_OPTIONS}) AS snippet, rank
      FROM limited
      ORDER BY rank DESC, updated_at DESC, id
    `) as Record<string, unknown>[]
    const marked = (await tx`
      SELECT d.id, d.slug, d.title, d.body, d.summary, d.audiences, d.kind, d.updated_at, 'current' AS status
      FROM doc d
      WHERE d.status = 'current' AND d.kind = 'article' AND strpos(d.body, ':::section') > 0
    `) as Record<string, unknown>[]
    const projected = await searchedMarkedRows(tx, marked, query, 'customer')
    return rankedRows([...unmarked, ...projected]).map(recordDocSearchMatchRow)
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
    if (!input.audience) {
      const rows = await tx`
        WITH search_query AS (
          SELECT websearch_to_tsquery('english', ${query}) AS value
        ), limited AS (
          SELECT d.id, d.slug, d.title, d.body, d.summary, d.status, d.kind, d.audiences, s.name AS space_name, q.value,
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
            AND (d.kind = 'article' OR ${input.includeWorking ?? false}::boolean)
            AND d.search_vector @@ q.value
          ORDER BY rank DESC, d.updated_at DESC, d.id
          LIMIT ${DOC_SEARCH_RESULT_LIMIT}
        )
        SELECT id, slug, title, body, summary, status, kind, audiences, space_name,
               ts_headline('english', body, value, ${TS_HEADLINE_OPTIONS}) AS snippet, rank
        FROM limited
        ORDER BY rank DESC, id
      `
      return rows.map((row: Record<string, unknown>) => recordDocSearchMatchRow(row))
    }
    const unmarked = (await tx`
      WITH search_query AS (
        SELECT websearch_to_tsquery('english', ${query}) AS value
      ), limited AS (
        SELECT d.id, d.slug, d.title, d.body, d.summary, d.status, d.kind, d.audiences, d.updated_at,
               s.name AS space_name, q.value, ts_rank(d.search_vector, q.value) AS rank
        FROM doc d
        JOIN space s ON s.id=d.space_id
        CROSS JOIN search_query q
        WHERE d.space_id = ANY(string_to_array(${selectedSpaceIds.join(',')}, ',')::uuid[])
          AND d.deleted_at IS NULL
          AND (${input.scope ?? null}::text IS NULL OR d.scope=${input.scope ?? null})
          AND ${input.audience}=ANY(d.audiences)
          AND (
            ${input.subject === undefined}::boolean
            OR (${input.subject === null}::boolean AND d.subject IS NULL)
            OR d.subject=${input.subject ?? null}
          )
          AND (d.status = 'current' OR (${input.includeDrafts ?? false}::boolean AND d.status = 'draft'))
          AND (d.kind = 'article' OR ${input.includeWorking ?? false}::boolean)
          AND strpos(d.body, ':::section') = 0
          AND d.search_vector @@ q.value
        ORDER BY rank DESC, d.updated_at DESC, d.id
        LIMIT ${DOC_SEARCH_RESULT_LIMIT}
      )
      SELECT id, slug, title, body, summary, status, kind, audiences, updated_at, space_name,
             ts_headline('english', body, value, ${TS_HEADLINE_OPTIONS}) AS snippet, rank
      FROM limited
      ORDER BY rank DESC, updated_at DESC, id
    `) as Record<string, unknown>[]
    const marked = (await tx`
        SELECT d.id, d.slug, d.title, d.body, d.summary, d.status, d.kind, d.audiences, d.updated_at, s.name AS space_name
        FROM doc d
        JOIN space s ON s.id=d.space_id
        WHERE d.space_id = ANY(string_to_array(${selectedSpaceIds.join(',')}, ',')::uuid[])
          AND d.deleted_at IS NULL
          AND (${input.scope ?? null}::text IS NULL OR d.scope=${input.scope ?? null})
          AND ${input.audience}=ANY(d.audiences)
          AND (
            ${input.subject === undefined}::boolean
            OR (${input.subject === null}::boolean AND d.subject IS NULL)
            OR d.subject=${input.subject ?? null}
          )
          AND (d.status = 'current' OR (${input.includeDrafts ?? false}::boolean AND d.status = 'draft'))
          AND (d.kind = 'article' OR ${input.includeWorking ?? false}::boolean)
          AND strpos(d.body, ':::section') > 0
    `) as Record<string, unknown>[]
    const projected = await searchedMarkedRows(tx, marked, query, input.audience)
    return rankedRows([...unmarked, ...projected]).map(recordDocSearchMatchRow)
  })
}
