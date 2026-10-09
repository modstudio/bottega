import type { DocAudience } from '../../shared/docs.ts'
import { type DocSearchMatch, DocSearchSchema } from './doc-contract.ts'
import { docList } from './orch.ts'

const LOCAL_DOC_SEARCH_LIMIT = 20
const SNIPPET_CONTEXT_CODE_POINTS = 60

export type LocalDocSearchInput = {
  query: string
  scope?: string
  subject?: string | null
  audience?: DocAudience
  includeDrafts?: boolean
}

export function docSnippet(
  body: string,
  query: string,
): { snippet: string; matchPosition: number | null } {
  const normalized = query.trim().toLocaleLowerCase()
  let foldedBody = ''
  const originalOffsets: number[] = []
  const originalEnds: number[] = []
  let originalOffset = 0
  for (const point of body) {
    const foldedPoint = point.toLocaleLowerCase()
    foldedBody += foldedPoint
    for (let offset = 0; offset < foldedPoint.length; offset++) {
      originalOffsets.push(originalOffset)
      originalEnds.push(originalOffset + point.length)
    }
    originalOffset += point.length
  }
  const foldedMatch = normalized ? foldedBody.indexOf(normalized) : -1
  if (foldedMatch < 0) {
    const snippet = Array.from(body)
      .slice(0, SNIPPET_CONTEXT_CODE_POINTS * 2)
      .join('')
    return {
      snippet,
      matchPosition: null,
    }
  }
  const bodyMatch = originalOffsets[foldedMatch]!
  const foldedEnd = foldedMatch + normalized.length
  const originalEnd = originalEnds[foldedEnd - 1]!
  const codePointIndex = Array.from(body.slice(0, bodyMatch)).length
  const queryCodePoints = Array.from(body.slice(bodyMatch, originalEnd)).length
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

export async function searchLocalDocs(
  input: LocalDocSearchInput,
  list: typeof docList = docList,
): Promise<DocSearchMatch[]> {
  const query = input.query.trim()
  if (!query) return []
  const filters = {
    scope: input.scope,
    subject: input.subject,
    audience: input.audience,
    match: query,
    bodyMatch: query,
  }
  const rows = (
    await Promise.all([
      list({ ...filters, status: 'current' }),
      ...(input.includeDrafts ? [list({ ...filters, status: 'draft' })] : []),
    ])
  ).flat()
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
      audiences: row.audiences,
      status: row.status ?? 'current',
      kind: row.kind ?? 'working',
      ...docSnippet(row.body, query),
    }))
}

export async function localDocSearch(input: LocalDocSearchInput) {
  return DocSearchSchema.parse({ items: await searchLocalDocs(input) })
}
