// concern: retrieval-benchmark
/** Runs the live, non-gating comparison of embeddings, reranking, and ripgrep. */
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type Chunk, chunkDocument, loadCorpus } from '../corpus/chunks.ts'
import { embed, endpointsFromEnvironment, probeEndpoints, rerank } from '../services/endpoints.ts'
import { keywordRanking } from './keyword.ts'
import { type Ranking, scoreRankings } from './metrics.ts'
import { BENCHMARK_QUERIES } from './queries.ts'

const EMBED_BATCH_SIZE = 64
const RERANK_CANDIDATES = 20

function cosine(left: number[], right: number[]): number {
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

function rankByEmbedding(chunks: Chunk[], vectors: number[][], queryVector: number[]): Chunk[] {
  return chunks
    .map((chunk, index) => ({ chunk, score: cosine(vectors[index] ?? [], queryVector) }))
    .sort((left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id))
    .map(({ chunk }) => chunk)
}

async function embedBatches(url: string, documents: string[]): Promise<number[][]> {
  const vectors: number[][] = []
  for (let start = 0; start < documents.length; start += EMBED_BATCH_SIZE) {
    vectors.push(...(await embed(url, documents.slice(start, start + EMBED_BATCH_SIZE))))
  }
  return vectors
}

async function validateQueries(repositoryRoot: string): Promise<void> {
  if (BENCHMARK_QUERIES.length < 20 || BENCHMARK_QUERIES.length > 40) {
    throw new Error(`benchmark requires 20 to 40 queries; found ${BENCHMARK_QUERIES.length}`)
  }
  for (const query of BENCHMARK_QUERIES) {
    await access(resolve(repositoryRoot, query.goldPath))
    const source = await readFile(resolve(repositoryRoot, query.provenance.path), 'utf8')
    const plainSource = source.replace(/[`*_]/g, '').replace(/\s+/g, ' ')
    const excerpt = query.provenance.excerpt.replace(/\s+/g, ' ')
    if (!plainSource.includes(excerpt)) {
      throw new Error(`${query.id} provenance excerpt is absent from ${query.provenance.path}`)
    }
  }
}

async function main() {
  const repositoryRoot = resolve(import.meta.dir, '../../..')
  await validateQueries(repositoryRoot)
  const endpoints = endpointsFromEnvironment(process.env)
  await probeEndpoints(endpoints)

  const startedAt = performance.now()
  const chunks = await loadCorpus(repositoryRoot)
  const documents = chunks.map(chunkDocument)
  const corpusVectors = await embedBatches(endpoints.embedUrl, documents)
  const queryVectors = await embedBatches(
    endpoints.embedUrl,
    BENCHMARK_QUERIES.map((query) => query.query),
  )
  const embeddingRankings: Ranking[] = []
  const rerankedRankings: Ranking[] = []
  const keywordRankings: Ranking[] = []

  for (const [index, query] of BENCHMARK_QUERIES.entries()) {
    const embedded = rankByEmbedding(chunks, corpusVectors, queryVectors[index] ?? [])
    embeddingRankings.push({ queryId: query.id, chunks: embedded, goldPath: query.goldPath })

    const candidates = embedded.slice(0, RERANK_CANDIDATES)
    const rerankScores = await rerank(
      endpoints.rerankUrl,
      query.query,
      candidates.map(chunkDocument),
    )
    const reranked = candidates
      .map((chunk, candidateIndex) => ({ chunk, score: rerankScores[candidateIndex] ?? -Infinity }))
      .sort(
        (left, right) => right.score - left.score || left.chunk.id.localeCompare(right.chunk.id),
      )
      .map(({ chunk }) => chunk)
    rerankedRankings.push({ queryId: query.id, chunks: reranked, goldPath: query.goldPath })

    keywordRankings.push({
      queryId: query.id,
      chunks: await keywordRanking(repositoryRoot, query.query, chunks),
      goldPath: query.goldPath,
    })
  }

  console.log(
    JSON.stringify(
      {
        queryCount: BENCHMARK_QUERIES.length,
        corpus: {
          files: new Set(chunks.map((chunk) => chunk.path)).size,
          chunks: chunks.length,
          chunking:
            '60-line windows with 10-line overlap; path and start line prefix each document',
        },
        methods: {
          embeddings: scoreRankings(embeddingRankings),
          embeddingsThenRerankTop20: scoreRankings(rerankedRankings),
          ripgrepKeyword: scoreRankings(keywordRankings),
        },
        keywordMethod:
          'ripgrep finds case-insensitive non-stopword query terms; chunks rank by distinct matched terms',
        durationSeconds: (performance.now() - startedAt) / 1000,
        queries: BENCHMARK_QUERIES,
      },
      null,
      2,
    ),
  )
}

await main()
