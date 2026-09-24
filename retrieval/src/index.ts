// concern: retrieval-index
/** Refreshes and searches the persistent document-vector index. */

import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { resolveRetrievalDatabase } from '../../shared/state-directory.ts'
import {
  EMBEDDING_DIMENSION,
  EMBEDDING_MODEL,
  INSTRUCTION_VERSION,
  queryDocument,
  RERANK_CANDIDATES,
} from './contract.ts'
import { type Chunk, chunkDocument, loadDocCorpus } from './corpus/chunks.ts'
import { embed, endpointsFromEnvironment, rerank } from './services/endpoints.ts'

const EMBED_BATCH_SIZE = 64
const SNIPPET_CHARACTERS = 500

export type StoredVectorRow = {
  chunkId: string
  contentHash: string
  model: string
  dimension: number
  instructionVersion: string
}

export type CurrentChunk = { chunk: Chunk; contentHash: string }
export type RefreshPlan = {
  embed: CurrentChunk[]
  delete: string[]
  unchanged: string[]
}

export type RefreshCounts = { embedded: number; deleted: number; unchanged: number }

export type SearchResult = {
  scope: string
  subject: string | null
  slug: string
  title: string
  headingPath: string[]
  snippet: string
  truncated: boolean
  embeddingScore: number
  rerankScore: number
}

export type SearchOutput = {
  query: string
  k: number
  contract: { model: string; dimension: number; instructionVersion: string }
  refresh: RefreshCounts
  results: SearchResult[]
}

type IndexedRow = StoredVectorRow & {
  scope: string
  subject: string | null
  slug: string
  title: string
  headingPath: string
  text: string
  document: string
  vector: Uint8Array
}

type Clients = {
  embed(url: string, input: string[]): Promise<number[][]>
  rerank(url: string, query: string, documents: string[]): Promise<number[]>
}

const currentContract = {
  model: EMBEDDING_MODEL,
  dimension: EMBEDDING_DIMENSION,
  instructionVersion: INSTRUCTION_VERSION,
}

export function contentHash(chunk: Chunk): string {
  return createHash('sha256').update(chunkDocument(chunk)).digest('hex')
}

export function planRefresh(current: CurrentChunk[], stored: StoredVectorRow[]): RefreshPlan {
  const currentIds = new Set(current.map(({ chunk }) => chunk.id))
  const storedById = new Map(stored.map((row) => [row.chunkId, row]))
  const plan: RefreshPlan = {
    embed: [],
    delete: stored
      .filter((row) => !currentIds.has(row.chunkId))
      .map((row) => row.chunkId)
      .sort(),
    unchanged: [],
  }
  for (const candidate of current) {
    const row = storedById.get(candidate.chunk.id)
    const matches =
      row?.contentHash === candidate.contentHash &&
      row.model === currentContract.model &&
      row.dimension === currentContract.dimension &&
      row.instructionVersion === currentContract.instructionVersion
    if (matches) plan.unchanged.push(candidate.chunk.id)
    else plan.embed.push(candidate)
  }
  plan.embed.sort((left, right) => left.chunk.id.localeCompare(right.chunk.id))
  plan.unchanged.sort()
  return plan
}

function createIndexDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true })
  const database = new Database(path, { create: true })
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS document_vector (
      chunk_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      model TEXT NOT NULL,
      dimension INTEGER NOT NULL,
      instruction_version TEXT NOT NULL,
      scope TEXT NOT NULL,
      subject TEXT,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      heading_path TEXT NOT NULL,
      text TEXT NOT NULL,
      document TEXT NOT NULL,
      vector BLOB NOT NULL
    );
  `)
  return database
}

function storedRows(database: Database): StoredVectorRow[] {
  return database
    .query<
      {
        chunk_id: string
        content_hash: string
        model: string
        dimension: number
        instruction_version: string
      },
      []
    >('SELECT chunk_id, content_hash, model, dimension, instruction_version FROM document_vector')
    .all()
    .map((row) => ({
      chunkId: row.chunk_id,
      contentHash: row.content_hash,
      model: row.model,
      dimension: row.dimension,
      instructionVersion: row.instruction_version,
    }))
}

function vectorBlob(vector: number[]): Uint8Array {
  if (vector.length !== EMBEDDING_DIMENSION) {
    throw new Error(
      `embedding endpoint returned dimension ${vector.length}; expected ${EMBEDDING_DIMENSION}`,
    )
  }
  return new Uint8Array(new Float32Array(vector).buffer)
}

export async function refreshIndex(
  database: Database,
  chunks: Chunk[],
  embedDocuments: (documents: string[]) => Promise<number[][]>,
): Promise<RefreshCounts> {
  const current = chunks.map((chunk) => ({ chunk, contentHash: contentHash(chunk) }))
  const plan = planRefresh(current, storedRows(database))
  const upsert = database.query(`
    INSERT INTO document_vector (
      chunk_id, content_hash, model, dimension, instruction_version,
      scope, subject, slug, title, heading_path, text, document, vector
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(chunk_id) DO UPDATE SET
      content_hash=excluded.content_hash, model=excluded.model,
      dimension=excluded.dimension, instruction_version=excluded.instruction_version,
      scope=excluded.scope, subject=excluded.subject, slug=excluded.slug,
      title=excluded.title, heading_path=excluded.heading_path, text=excluded.text,
      document=excluded.document, vector=excluded.vector
  `)
  const remove = database.query('DELETE FROM document_vector WHERE chunk_id = ?')
  database.transaction(() => {
    for (const chunkId of plan.delete) remove.run(chunkId)
  })()
  for (let start = 0; start < plan.embed.length; start += EMBED_BATCH_SIZE) {
    const batch = plan.embed.slice(start, start + EMBED_BATCH_SIZE)
    const vectors = await embedDocuments(batch.map(({ chunk }) => chunkDocument(chunk)))
    if (vectors.length !== batch.length) {
      throw new Error('embedding endpoint did not return one vector per indexed chunk')
    }
    database.transaction(() => {
      for (const [index, candidate] of batch.entries()) {
        const identity = candidate.chunk.identity
        if (identity.kind !== 'doc') throw new Error('retrieval index accepts document chunks only')
        upsert.run(
          candidate.chunk.id,
          candidate.contentHash,
          EMBEDDING_MODEL,
          EMBEDDING_DIMENSION,
          INSTRUCTION_VERSION,
          identity.scope,
          identity.subject,
          identity.slug,
          candidate.chunk.docTitle ?? '',
          JSON.stringify(candidate.chunk.headingPath ?? []),
          candidate.chunk.text,
          chunkDocument(candidate.chunk),
          vectorBlob(vectors[index] ?? []),
        )
      }
    })()
  }
  return {
    embedded: plan.embed.length,
    deleted: plan.delete.length,
    unchanged: plan.unchanged.length,
  }
}

export function cosine(left: Float32Array, right: Float32Array): number {
  if (left.length !== right.length) throw new Error('cosine vectors must have equal dimensions')
  let dot = 0
  let leftMagnitude = 0
  let rightMagnitude = 0
  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index] ?? 0
    const rightValue = right[index] ?? 0
    dot += leftValue * rightValue
    leftMagnitude += leftValue * leftValue
    rightMagnitude += rightValue * rightValue
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude)
  return denominator ? dot / denominator : 0
}

export function cosineTopK(
  vectors: Array<{ id: string; vector: Float32Array }>,
  query: Float32Array,
  k: number,
): Array<{ id: string; score: number }> {
  return vectors
    .map(({ id, vector }) => ({ id, score: cosine(vector, query) }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, k)
}

function indexedRows(database: Database): IndexedRow[] {
  return database
    .query<Record<string, unknown>, []>('SELECT * FROM document_vector ORDER BY chunk_id')
    .all()
    .map((row) => ({
      chunkId: String(row.chunk_id),
      contentHash: String(row.content_hash),
      model: String(row.model),
      dimension: Number(row.dimension),
      instructionVersion: String(row.instruction_version),
      scope: String(row.scope),
      subject: row.subject === null ? null : String(row.subject),
      slug: String(row.slug),
      title: String(row.title),
      headingPath: String(row.heading_path),
      text: String(row.text),
      document: String(row.document),
      vector: row.vector as Uint8Array,
    }))
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
): Promise<SearchOutput> {
  if (!query.trim()) throw new Error('search query must not be empty')
  if (!Number.isInteger(k) || k < 1) throw new Error('search k must be a positive integer')
  const environment = options.environment ?? process.env
  const endpoints = endpointsFromEnvironment(environment)
  const clients = options.clients ?? { embed, rerank }
  const database = createIndexDatabase(
    options.databasePath ?? resolveRetrievalDatabase(environment),
  )
  try {
    const repositoryRoot = options.repositoryRoot ?? resolve(import.meta.dir, '../..')
    const chunks = await (options.loadChunks ?? loadDocCorpus)(repositoryRoot)
    const refresh = await refreshIndex(database, chunks, (documents) =>
      clients.embed(endpoints.embedUrl, documents),
    )
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
      refresh,
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
