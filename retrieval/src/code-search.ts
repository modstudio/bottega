// concern: retrieval-code-search
/** Adapts a caller checkout and the content-addressed cache to indexed search. */

import type { CodeSearchOutput } from '../../shared/orch-contract.ts'
import { type Chunk, loadCodeCorpus } from './corpus/chunks.ts'
import { applyCodeCacheRefresh, type CodeCacheRow, planCodeCache } from './index-store.ts'
import {
  boundedSnippet,
  type IndexedCandidate,
  indexedSearch,
  type SearchClients,
} from './indexed-search.ts'

export async function searchCode(
  project: { name: string; path: string },
  query: string,
  k: number,
  options: {
    environment?: NodeJS.ProcessEnv
    databasePath?: string
    clients?: SearchClients
    loadChunks?: (repositoryRoot: string) => Promise<Chunk[]>
    now?: number
    retentionMs?: number
  } = {},
): Promise<CodeSearchOutput> {
  let plannedHits = new Map<string, CodeCacheRow>()
  let embeddedRows = new Map<
    string,
    { contentHash: string; document: string; vector: Uint8Array }
  >()
  return indexedSearch(
    query,
    k,
    {
      loadChunks: () => (options.loadChunks ?? loadCodeCorpus)(project.path),
      plan: (database, candidates) => {
        const planned = planCodeCache(
          database,
          candidates.map(({ contentHash }) => contentHash),
          options.now,
        )
        plannedHits = new Map(planned.hits.map((row) => [row.contentHash, row]))
        const missing = new Set(planned.missingContentHashes)
        const missingByHash = new Map<string, IndexedCandidate>()
        for (const candidate of candidates) {
          if (missing.has(candidate.contentHash) && !missingByHash.has(candidate.contentHash)) {
            missingByHash.set(candidate.contentHash, candidate)
          }
        }
        return {
          embed: [...missingByHash.values()],
          unchanged: candidates.filter(({ contentHash }) => plannedHits.has(contentHash)).length,
        }
      },
      apply: (database, candidates, embedded) => {
        embeddedRows = new Map(
          embedded.map((row) => [
            row.contentHash,
            {
              contentHash: row.contentHash,
              document: row.document,
              vector: new Uint8Array(new Float32Array(row.vector).buffer),
            },
          ]),
        )
        const applied = applyCodeCacheRefresh(database, {
          seenContentHashes: candidates.map(({ contentHash }) => contentHash),
          embedded,
          now: options.now,
          retentionMs: options.retentionMs,
        })
        return {
          embedded: applied.embedded,
          deleted: 0,
          unchanged: candidates.length - embedded.length,
          stale: 0,
          pruned: applied.pruned,
        }
      },
      rows: (_database, candidates) => {
        return candidates.map((candidate) => {
          const row =
            plannedHits.get(candidate.contentHash) ?? embeddedRows.get(candidate.contentHash)
          if (!row) throw new Error(`code vector plan missed ${candidate.contentHash}`)
          return {
            ...row,
            id: candidate.chunk.id,
            text: candidate.chunk.text,
            chunk: candidate.chunk,
          }
        })
      },
    },
    (row, scores) => ({
      project: project.name,
      path: row.chunk.path,
      startLine: row.chunk.startLine,
      endLine: row.chunk.endLine,
      ...boundedSnippet(row.text),
      ...scores,
    }),
    options,
  )
}
