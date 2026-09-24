// concern: retrieval-code-search
/** Refreshes one project's code-vector corpus and serves semantic code search. */

import { createHash } from 'node:crypto'
import type { CodeSearchOutput } from '../../shared/orch-contract.ts'
import { resolveRetrievalDatabase } from '../../shared/state-directory.ts'
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  INSTRUCTION_VERSION,
  queryDocument,
  RERANK_CANDIDATES,
} from './contract.ts'
import { type Chunk, chunkDocument, loadCodeCorpus } from './corpus/chunks.ts'
import { applyRefresh, indexedRows, openIndexDatabase, storedRows } from './index-store.ts'
import { planRefresh } from './refresh-plan.ts'
import { embed, endpointsFromEnvironment, rerank } from './services/endpoints.ts'
import { cosineTopK } from './vector-ranking.ts'

const EMBED_BATCH_SIZE = 64
const SNIPPET_CHARACTERS = 500

type Clients = {
  embed(url: string, input: string[]): Promise<number[][]>
  rerank(url: string, query: string, documents: string[]): Promise<number[]>
}

const currentContract = {
  model: EMBEDDING_MODEL,
  dimension: EMBEDDING_DIMENSION,
  instructionVersion: INSTRUCTION_VERSION,
}

function contentHash(chunk: Chunk): string {
  return createHash('sha256').update(chunkDocument(chunk)).digest('hex')
}

export async function searchCode(
  project: { name: string; path: string },
  query: string,
  k: number,
  options: {
    environment?: NodeJS.ProcessEnv
    databasePath?: string
    clients?: Clients
    loadChunks?: (repositoryRoot: string) => Promise<Chunk[]>
  } = {},
): Promise<CodeSearchOutput> {
  if (!query.trim()) throw new Error('search query must not be empty')
  if (!Number.isInteger(k) || k < 1) throw new Error('search k must be a positive integer')
  const environment = options.environment ?? process.env
  const endpoints = endpointsFromEnvironment(environment)
  const clients = options.clients ?? { embed, rerank }
  const corpusKey = `code:${project.name}`
  const database = openIndexDatabase(options.databasePath ?? resolveRetrievalDatabase(environment))
  try {
    const loaded = await (options.loadChunks ?? loadCodeCorpus)(project.path)
    const chunks = loaded.map((chunk) => ({ ...chunk, id: `${corpusKey}:${chunk.id}` }))
    const current = chunks.map((chunk) => ({ chunk, contentHash: contentHash(chunk) }))
    const plan = planRefresh(current, storedRows(database, corpusKey))
    const embeddedRows = []
    for (let start = 0; start < plan.embed.length; start += EMBED_BATCH_SIZE) {
      const batch = plan.embed.slice(start, start + EMBED_BATCH_SIZE)
      const vectors = await clients.embed(
        endpoints.embedUrl,
        batch.map(({ chunk }) => chunkDocument(chunk)),
      )
      if (vectors.length !== batch.length) {
        throw new Error('embedding endpoint did not return one vector per indexed chunk')
      }
      embeddedRows.push(
        ...batch.map((candidate, index) => ({
          ...candidate,
          document: chunkDocument(candidate.chunk),
          vector: vectors[index] ?? [],
        })),
      )
    }
    const applied = applyRefresh(database, {
      corpusKey,
      project: project.name,
      delete: plan.delete,
      upsert: embeddedRows,
    })
    const [queryVector] = await clients.embed(endpoints.embedUrl, [queryDocument(query)])
    const queryArray = new Float32Array(queryVector ?? [])
    if (queryArray.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `embedding endpoint returned query dimension ${queryArray.length}; expected ${EMBEDDING_DIMENSION}`,
      )
    }
    const rows = indexedRows(database, corpusKey).filter(
      (row) =>
        row.model === EMBEDDING_MODEL &&
        row.dimension === EMBEDDING_DIMENSION &&
        row.instructionVersion === INSTRUCTION_VERSION,
    )
    const byId = new Map(rows.map((row) => [row.chunkId, row]))
    const embedded = cosineTopK(
      rows.map((row) => ({
        id: row.chunkId,
        vector: new Float32Array(
          row.vector.buffer,
          row.vector.byteOffset,
          row.vector.byteLength / Float32Array.BYTES_PER_ELEMENT,
        ),
      })),
      queryArray,
      Math.min(RERANK_CANDIDATES, rows.length),
    )
    const candidates = embedded.map(({ id }) => byId.get(id)!)
    const rerankScores = await clients.rerank(
      endpoints.rerankUrl,
      query,
      candidates.map((row) => row.document),
    )
    const embeddingScores = new Map(embedded.map(({ id, score }) => [id, score]))
    const ranked = candidates
      .map((row, index) => ({ row, rerankScore: rerankScores[index] ?? Number.NEGATIVE_INFINITY }))
      .sort(
        (left, right) =>
          right.rerankScore - left.rerankScore || left.row.chunkId.localeCompare(right.row.chunkId),
      )
      .slice(0, k)
    return {
      query,
      k,
      contract: currentContract,
      refresh: {
        embedded: applied.embedded,
        deleted: applied.deleted,
        unchanged: plan.unchanged.length,
        stale: applied.stale,
      },
      results: ranked.map(({ row, rerankScore }) => {
        const characters = Array.from(row.text)
        return {
          project: row.project ?? project.name,
          path: row.repositoryPath ?? '',
          startLine: row.startLine ?? 1,
          endLine: row.endLine ?? 1,
          snippet: characters.slice(0, SNIPPET_CHARACTERS).join(''),
          truncated: characters.length > SNIPPET_CHARACTERS,
          embeddingScore: embeddingScores.get(row.chunkId)!,
          rerankScore,
        }
      }),
    }
  } finally {
    database.close()
  }
}
