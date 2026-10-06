import type { DocAudience } from '../../shared/docs.ts'
import { DocSchema, type DocSearchMatch, DocSearchSchema, DocTreeSchema } from './doc-contract.ts'
import { type DocListFilters, type DocRow, docGet, docList } from './orch.ts'

export const LOCAL_DOC_SEARCH_LIMIT = 20
const SNIPPET_CONTEXT_CODE_POINTS = 60

export type LocalDocSearchInput = {
  query: string
  scope?: string
  subject?: string | null
  audience?: DocAudience
}

export function docSnippet(
  body: string,
  _title: string,
  query: string,
): { snippet: string; matchPosition: number | null } {
  const normalized = query.trim().toLocaleLowerCase()
  const bodyMatch = normalized ? body.toLocaleLowerCase().indexOf(normalized) : -1
  if (bodyMatch < 0) {
    const snippet = Array.from(body)
      .slice(0, SNIPPET_CONTEXT_CODE_POINTS * 2)
      .join('')
    return {
      snippet,
      matchPosition: null,
    }
  }
  const codePointIndex = Array.from(body.slice(0, bodyMatch)).length
  const queryCodePoints = Array.from(body.slice(bodyMatch, bodyMatch + normalized.length)).length
  const points = Array.from(body)
  const start = Math.max(0, codePointIndex - SNIPPET_CONTEXT_CODE_POINTS)
  const end = Math.min(
    points.length,
    codePointIndex + queryCodePoints + SNIPPET_CONTEXT_CODE_POINTS,
  )
  const snippet = points.slice(start, end).join('')
  const prefix = points.slice(start, codePointIndex).join('')
  return { snippet, matchPosition: prefix.length }
}

export function localDocTreeItem(row: DocRow) {
  return {
    id: String(row.id),
    slug: row.slug,
    title: row.title,
    parentId: row.parent_id === null ? null : String(row.parent_id),
    position: row.position,
    updatedAt: row.updated_at,
    scope: row.scope,
    subject: row.subject,
    audience: row.audience,
  }
}

export function localDoc(row: DocRow) {
  return { ...localDocTreeItem(row), body: row.body }
}

export async function localDocsTree(filters: DocListFilters, list: typeof docList = docList) {
  return DocTreeSchema.parse({ items: (await list(filters)).map(localDocTreeItem) })
}

export async function localDocDetail(
  input: { scope: string; subject: string | null; slug: string },
  get: typeof docGet = docGet,
) {
  return DocSchema.parse(localDoc(await get(input.scope, input.subject, input.slug)))
}

export async function searchLocalDocs(
  input: LocalDocSearchInput,
  list: typeof docList = docList,
): Promise<DocSearchMatch[]> {
  const query = input.query.trim()
  if (!query) return []
  const rows = await list({
    scope: input.scope,
    subject: input.subject,
    audience: input.audience,
    match: query,
    bodyMatch: query,
  })
  const normalized = query.toLocaleLowerCase()
  return rows
    .filter((row) =>
      [row.title, row.slug, row.body].some((value) =>
        value.toLocaleLowerCase().includes(normalized),
      ),
    )
    .slice(0, LOCAL_DOC_SEARCH_LIMIT)
    .map((row) => ({
      id: String(row.id),
      slug: row.slug,
      title: row.title,
      ...docSnippet(row.body, row.title, query),
    }))
}

export async function localDocSearch(input: LocalDocSearchInput) {
  return DocSearchSchema.parse({ items: await searchLocalDocs(input) })
}
