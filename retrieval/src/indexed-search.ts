// concern: retrieval-indexed-search
/** Owns the shared embedding, exact-ranking, reranking, and snippet pipeline. */

import type { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { resolveRetrievalDatabase } from '../../shared/state-directory.ts'
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  INSTRUCTION_VERSION,
  queryDocument,
  RERANK_CANDIDATES,
} from './contract.ts'
import { type Chunk, chunkDocument } from './corpus/chunks.ts'
import { openIndexDatabase } from './index-store.ts'
import type { StoredVectorIdentity } from './refresh-plan.ts'
import { embed, endpointsFromEnvironment, rerank } from './services/endpoints.ts'
import { cosineTopK } from './vector-ranking.ts'

const EMBED_BATCH_SIZE = 64
const SNIPPET_CHARACTERS = 500

export type SearchClients = {
  embed(url: string, input: string[]): Promise<number[][]>
  rerank(url: string, query: string, documents: string[]): Promise<number[]>
}

export type IndexedCandidate = {
  chunk: Chunk
  contentHash: string
  document: string
  observed?: StoredVectorIdentity | null
}

export type SearchableRow = {
  id: string
  text: string
  document: string
  vector: Uint8Array
}

export type RefreshCounts = {
  embedded: number
  deleted: number
  unchanged: number
  stale: number
  pruned?: number
}

export type SearchStrategy<Row extends SearchableRow, Refresh extends RefreshCounts> = {
  loadChunks(): Promise<Chunk[]>
  plan(
    database: Database,
    candidates: IndexedCandidate[],
  ): {
    embed: IndexedCandidate[]
    unchanged: number
  }
  apply(
    database: Database,
    candidates: IndexedCandidate[],
    embedded: Array<IndexedCandidate & { vector: number[] }>,
  ): Refresh
  rows(database: Database, candidates: IndexedCandidate[]): Row[]
}

export const currentContract = {
  model: EMBEDDING_MODEL,
  dimension: EMBEDDING_DIMENSION,
  instructionVersion: INSTRUCTION_VERSION,
}

function contentHash(chunk: Chunk): string {
  return createHash('sha256').update(chunkDocument(chunk)).digest('hex')
}

export async function indexedSearch<
  Row extends SearchableRow,
  Result,
  Refresh extends RefreshCounts,
>(
  query: string,
  k: number,
  strategy: SearchStrategy<Row, Refresh>,
  project: (row: Row, scores: { embeddingScore: number; rerankScore: number }) => Result,
  options: {
    environment?: NodeJS.ProcessEnv
    databasePath?: string
    clients?: SearchClients
  } = {},
): Promise<{
  query: string
  k: number
  contract: typeof currentContract
  refresh: Refresh
  results: Result[]
}> {
  if (!query.trim()) throw new Error('search query must not be empty')
  if (!Number.isInteger(k) || k < 1) throw new Error('search k must be a positive integer')
  const environment = options.environment ?? process.env
  const endpoints = endpointsFromEnvironment(environment)
  const clients = options.clients ?? { embed, rerank }
  const database = openIndexDatabase(options.databasePath ?? resolveRetrievalDatabase(environment))
  try {
    const candidates = (await strategy.loadChunks()).map((chunk) => ({
      chunk,
      contentHash: contentHash(chunk),
      document: chunkDocument(chunk),
    }))
    const plan = strategy.plan(database, candidates)
    const embedded: Array<IndexedCandidate & { vector: number[] }> = []
    for (let start = 0; start < plan.embed.length; start += EMBED_BATCH_SIZE) {
      const batch = plan.embed.slice(start, start + EMBED_BATCH_SIZE)
      const vectors = await clients.embed(
        endpoints.embedUrl,
        batch.map(({ document }) => document),
      )
      if (vectors.length !== batch.length) {
        throw new Error('embedding endpoint did not return one vector per indexed chunk')
      }
      embedded.push(
        ...batch.map((candidate, index) => ({ ...candidate, vector: vectors[index] ?? [] })),
      )
    }
    const refresh = strategy.apply(database, candidates, embedded)
    const [queryVector] = await clients.embed(endpoints.embedUrl, [queryDocument(query)])
    const queryArray = new Float32Array(queryVector ?? [])
    if (queryArray.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `embedding endpoint returned query dimension ${queryArray.length}; expected ${EMBEDDING_DIMENSION}`,
      )
    }
    const rows = strategy.rows(database, candidates)
    const byId = new Map(rows.map((row) => [row.id, row]))
    const nearest = cosineTopK(
      rows.map((row) => ({
        id: row.id,
        vector: new Float32Array(
          row.vector.buffer,
          row.vector.byteOffset,
          row.vector.byteLength / Float32Array.BYTES_PER_ELEMENT,
        ),
      })),
      queryArray,
      Math.min(RERANK_CANDIDATES, rows.length),
    )
    const candidatesToRerank = nearest.map(({ id }) => byId.get(id)!)
    const rerankScores = await clients.rerank(
      endpoints.rerankUrl,
      query,
      candidatesToRerank.map((row) => row.document),
    )
    const embeddingScores = new Map(nearest.map(({ id, score }) => [id, score]))
    const ranked = candidatesToRerank
      .map((row, index) => ({ row, rerankScore: rerankScores[index] ?? Number.NEGATIVE_INFINITY }))
      .sort(
        (left, right) =>
          right.rerankScore - left.rerankScore || left.row.id.localeCompare(right.row.id),
      )
      .slice(0, k)
    return {
      query,
      k,
      contract: currentContract,
      refresh,
      results: ranked.map(({ row, rerankScore }) =>
        project(row, { embeddingScore: embeddingScores.get(row.id)!, rerankScore }),
      ),
    }
  } finally {
    database.close()
  }
}

export function boundedSnippet(text: string): { snippet: string; truncated: boolean } {
  const characters = Array.from(text)
  return {
    snippet: characters.slice(0, SNIPPET_CHARACTERS).join(''),
    truncated: characters.length > SNIPPET_CHARACTERS,
  }
}
