import { DOC_SNIPPET_START, DOC_SNIPPET_STOP, docPlainSnippet } from '../../shared/doc-snippet.ts'
import { type DocAudience, effectiveDocSummary } from '../../shared/docs.ts'
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
  includeWorking?: boolean
}

export function docSnippet(body: string, query: string) {
  const normalized = query.trim().toLocaleLowerCase()
  const plainBody = docPlainSnippet(body).snippet
  let foldedBody = ''
  const originalOffsets: number[] = []
  const originalEnds: number[] = []
  let originalOffset = 0
  for (const point of plainBody) {
    const foldedPoint = point.toLocaleLowerCase()
    foldedBody += foldedPoint
    for (let offset = 0; offset < foldedPoint.length; offset++) {
      originalOffsets.push(originalOffset)
      originalEnds.push(originalOffset + point.length)
    }
    originalOffset += point.length
  }
  const foldedMatch = normalized ? foldedBody.indexOf(normalized) : -1
  const points = Array.from(plainBody)
  if (foldedMatch < 0) {
    return docPlainSnippet(points.slice(0, SNIPPET_CONTEXT_CODE_POINTS * 2).join(''))
  }
  const bodyMatch = originalOffsets[foldedMatch]!
  const foldedEnd = foldedMatch + normalized.length
  const originalEnd = originalEnds[foldedEnd - 1]!
  const codePointIndex = Array.from(plainBody.slice(0, bodyMatch)).length
  const queryCodePoints = Array.from(plainBody.slice(bodyMatch, originalEnd)).length
  const start = Math.max(0, codePointIndex - SNIPPET_CONTEXT_CODE_POINTS)
  const end = Math.min(
    points.length,
    codePointIndex + queryCodePoints + SNIPPET_CONTEXT_CODE_POINTS,
  )
  const prefix = points.slice(start, codePointIndex).join('')
  const match = points.slice(codePointIndex, codePointIndex + queryCodePoints).join('')
  const suffix = points.slice(codePointIndex + queryCodePoints, end).join('')
  return docPlainSnippet(`${prefix}${DOC_SNIPPET_START}${match}${DOC_SNIPPET_STOP}${suffix}`)
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
    .filter((row) => input.includeWorking || row.kind === 'article')
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
      kind: row.kind,
      ...effectiveDocSummary(row.summary, row.body),
      ...docSnippet(row.body, query),
    }))
}

export async function localDocSearch(input: LocalDocSearchInput) {
  return DocSearchSchema.parse({ items: await searchLocalDocs(input) })
}
