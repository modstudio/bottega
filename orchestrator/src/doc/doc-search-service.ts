// concern: doc-search-service
/** Adds local document metadata to the stable semantic-search adapter result. */

import { effectiveDocSummary } from '../../../shared/docs.ts'
import { type DocSearchOutput, DocSearchOutputSchema } from '../../../shared/orch-contract.ts'
import { getDocStore } from './doc-read-store.ts'
import { searchDocs as searchDocIndex } from './doc-search.ts'

type SearchFilter = { scope?: string; subject?: string; includeDrafts?: boolean }
type SearchIndex = typeof searchDocIndex
type DocReader = typeof getDocStore

export async function searchDocs(
  query: string,
  k: number,
  filter: SearchFilter = {},
  searchIndex: SearchIndex = searchDocIndex,
  readDoc: DocReader = getDocStore,
): Promise<DocSearchOutput & { notice?: string }> {
  const output = await searchIndex(query, k, filter)
  const parsed = DocSearchOutputSchema.parse({
    ...output,
    results: output.results.map((result) => {
      const doc = readDoc(result.scope, result.subject, result.slug)
      return { ...result, ...effectiveDocSummary(doc?.summary, doc?.body ?? '') }
    }),
  })
  return output.notice ? { ...parsed, notice: output.notice } : parsed
}
