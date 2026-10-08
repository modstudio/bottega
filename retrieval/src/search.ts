// concern: retrieval-search
/** Adapts the document corpus and compare-and-swap store to indexed search. */

import { resolve } from 'node:path'
import type { DocSearchOutput } from '../../shared/orch-contract.ts'
import { type Chunk, loadDocCorpus } from './corpus/chunks.ts'
import { applyRefresh, indexedRows, storedRows } from './index-store.ts'
import {
  boundedSnippet,
  currentContract,
  indexedSearch,
  type SearchClients,
} from './indexed-search.ts'
import { planRefresh } from './refresh-plan.ts'

export async function search(
  query: string,
  k: number,
  options: {
    repositoryRoot?: string
    environment?: NodeJS.ProcessEnv
    databasePath?: string
    clients?: SearchClients
    loadChunks?: (repositoryRoot: string) => Promise<Chunk[]>
    scope?: string
    subject?: string
    includeDrafts?: boolean
  } = {},
): Promise<DocSearchOutput> {
  const repositoryRoot = options.repositoryRoot ?? resolve(import.meta.dir, '../..')
  let refreshPlan: ReturnType<typeof planRefresh> | undefined
  return indexedSearch(
    query,
    k,
    {
      loadChunks: () => (options.loadChunks ?? loadDocCorpus)(repositoryRoot),
      plan: (database, candidates) => {
        const plan = planRefresh(candidates, storedRows(database, 'docs'))
        refreshPlan = plan
        const documents = new Map(
          candidates.map((candidate) => [candidate.chunk.id, candidate.document]),
        )
        return {
          embed: plan.embed.map((candidate) => ({
            ...candidate,
            document: documents.get(candidate.chunk.id)!,
          })),
          unchanged: plan.unchanged.length,
        }
      },
      apply: (database, _candidates, embedded) => {
        if (!refreshPlan) throw new Error('document refresh was not planned')
        const applied = applyRefresh(database, {
          corpusKey: 'docs',
          delete: refreshPlan.delete,
          upsert: embedded.map((candidate) => ({
            ...candidate,
            observed: candidate.observed ?? null,
          })),
        })
        return {
          embedded: applied.embedded,
          deleted: applied.deleted,
          unchanged: refreshPlan.unchanged.length,
          stale: applied.stale,
        }
      },
      rows: (database) =>
        indexedRows(database, 'docs')
          .filter(
            (row) =>
              row.model === currentContract.model &&
              row.dimension === currentContract.dimension &&
              row.instructionVersion === currentContract.instructionVersion &&
              (options.scope === undefined || row.scope === options.scope) &&
              (options.subject === undefined || row.subject === options.subject) &&
              (row.status === 'current' ||
                (options.includeDrafts === true && row.status === 'draft')),
          )
          .map((row) => ({ ...row, id: row.chunkId })),
    },
    (row, scores) => ({
      scope: row.scope,
      subject: row.subject,
      slug: row.slug,
      title: row.title,
      status: row.status === 'draft' ? 'draft' : 'current',
      headingPath: JSON.parse(row.headingPath) as string[],
      ...boundedSnippet(row.text),
      ...scores,
    }),
    options,
  )
}
