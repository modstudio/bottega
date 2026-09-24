// concern: retrieval-search
/** Refreshes the document-vector index and serves semantic document search. */

import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { DocSearchOutput } from '../../shared/orch-contract.ts'
import { resolveRetrievalDatabase } from '../../shared/state-directory.ts'
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  INSTRUCTION_VERSION,
  queryDocument,
  RERANK_CANDIDATES,
} from './contract.ts'
import { type Chunk, chunkDocument, loadDocCorpus } from './corpus/chunks.ts'
import { planRefresh } from './index.ts'
import { applyRefresh, indexedRows, openIndexDatabase, storedRows } from './index-store.ts'
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

export async function search(
  query: string,
  k: number,
  options: {
    repositoryRoot?: string
    environment?: NodeJS.ProcessEnv
    databasePath?: string
    clients?: Clients
    loadChunks?: (repositoryRoot: string) => Promise<Chunk[]>
  } = {},
): Promise<DocSearchOutput> {
  if (!query.trim()) throw new Error('search query must not be empty')
  if (!Number.isInteger(k) || k < 1) throw new Error('search k must be a positive integer')
  const environment = options.environment ?? process.env
  const endpoints = endpointsFromEnvironment(environment)
  const clients = options.clients ?? { embed, rerank }
  const database = openIndexDatabase(options.databasePath ?? resolveRetrievalDatabase(environment))
  try {
    const repositoryRoot = options.repositoryRoot ?? resolve(import.meta.dir, '../..')
    const chunks = await (options.loadChunks ?? loadDocCorpus)(repositoryRoot)
    const current = chunks.map((chunk) => ({ chunk, contentHash: contentHash(chunk) }))
    const plan = planRefresh(current, storedRows(database))
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
    applyRefresh(database, plan, embeddedRows)

    const [queryVector] = await clients.embed(endpoints.embedUrl, [queryDocument(query)])
    const queryArray = new Float32Array(queryVector ?? [])
    if (queryArray.length !== EMBEDDING_DIMENSION) {
      throw new Error(
        `embedding endpoint returned query dimension ${queryArray.length}; expected ${EMBEDDING_DIMENSION}`,
      )
    }
    const rows = indexedRows(database).filter(
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
        embedded: plan.embed.length,
        deleted: plan.delete.length,
        unchanged: plan.unchanged.length,
      },
      results: ranked.map(({ row, rerankScore }) => {
        const characters = Array.from(row.text)
        const truncated = characters.length > SNIPPET_CHARACTERS
        return {
          scope: row.scope,
          subject: row.subject,
          slug: row.slug,
          title: row.title,
          headingPath: JSON.parse(row.headingPath) as string[],
          snippet: characters.slice(0, SNIPPET_CHARACTERS).join(''),
          truncated,
          embeddingScore: embeddingScores.get(row.chunkId)!,
          rerankScore,
        }
      }),
    }
  } finally {
    database.close()
  }
}
