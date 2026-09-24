// concern: retrieval-benchmark
/** Runs the live, non-gating comparison of embeddings, reranking, and ripgrep. */
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { type Chunk, chunkDocument, loadCorpus } from '../corpus/chunks.ts'
import {
  embed,
  embeddingCharacterLimit,
  endpointsFromEnvironment,
  probeEndpoints,
  rerank,
} from '../services/endpoints.ts'
import { keywordRanking } from './keyword.ts'
import { type Ranking, rankOfFirstLabel, scoreRankings } from './metrics.ts'
import { CODE_QUERIES, DOC_QUERIES, type DocBenchmarkQuery, type LabelledQuery } from './queries.ts'

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

async function validateQueries(repositoryRoot: string, chunks: Chunk[]): Promise<void> {
  if (CODE_QUERIES.length < 20 || CODE_QUERIES.length > 40) {
    throw new Error(`code benchmark requires 20 to 40 queries; found ${CODE_QUERIES.length}`)
  }
  for (const query of CODE_QUERIES) {
    const goldPath = query.goldLabels[0]
    if (!goldPath) throw new Error(`${query.id} has no code label`)
    await access(resolve(repositoryRoot, goldPath))
    const source = await readFile(resolve(repositoryRoot, query.provenance.path), 'utf8')
    const plainSource = source.replace(/[`*_]/g, '').replace(/\s+/g, ' ')
    const excerpt = query.provenance.excerpt.replace(/\s+/g, ' ')
    if (!plainSource.includes(excerpt)) {
      throw new Error(`${query.id} provenance excerpt is absent from ${query.provenance.path}`)
    }
  }
  if (DOC_QUERIES.length < 25) {
    throw new Error(`doc benchmark requires at least 25 queries; found ${DOC_QUERIES.length}`)
  }
  const scopes = new Set(DOC_QUERIES.map((query) => query.scope))
  for (const scope of ['project', 'global', 'agent', 'machine', 'job', 'canon']) {
    if (!scopes.has(scope as DocBenchmarkQuery['scope'])) {
      throw new Error(`doc benchmark has no ${scope} query`)
    }
  }
  const chunksByLabel = new Map<string, Chunk[]>()
  for (const chunk of chunks) {
    if (chunk.identity.kind !== 'doc') continue
    const current = chunksByLabel.get(chunk.path) ?? []
    current.push(chunk)
    chunksByLabel.set(chunk.path, current)
  }
  for (const query of DOC_QUERIES) {
    for (const label of query.goldLabels) {
      if (!chunksByLabel.has(label)) throw new Error(`${query.id} doc label is absent: ${label}`)
    }
    const normalize = (value: string) =>
      value.replace(/[`*_]/g, '').replace(/\s+/g, ' ').toLowerCase()
    const found = chunksByLabel
      .get(query.provenance.doc)
      ?.some((chunk) => normalize(chunk.text).includes(normalize(query.provenance.excerpt)))
    if (!found) {
      throw new Error(`${query.id} provenance excerpt is absent from ${query.provenance.doc}`)
    }
  }
}

function reportSet(
  queries: LabelledQuery[],
  rankings: { keyword: Ranking[]; embeddings: Ranking[]; reranked: Ranking[] },
) {
  const missedIds = rankings.keyword
    .filter((ranking) => rankOfFirstLabel(ranking) < 0 || rankOfFirstLabel(ranking) >= 5)
    .map((ranking) => ranking.queryId)
    .filter((queryId) =>
      [rankings.embeddings, rankings.reranked].every((method) => {
        const ranking = method.find((candidate) => candidate.queryId === queryId)
        return (
          ranking !== undefined && (rankOfFirstLabel(ranking) < 0 || rankOfFirstLabel(ranking) >= 5)
        )
      }),
    )
  return {
    queryCount: queries.length,
    methods: {
      keyword: scoreRankings(rankings.keyword),
      embeddings: scoreRankings(rankings.embeddings),
      embeddingsPlusRerank: scoreRankings(rankings.reranked),
    },
    missedByEveryMethodAt5: queries
      .filter((query) => missedIds.includes(query.id))
      .map(({ id, query, goldLabels }) => ({ id, query, goldLabels })),
  }
}

async function main() {
  const repositoryRoot = resolve(import.meta.dir, '../../..')
  const endpoints = endpointsFromEnvironment(process.env)
  const docMaxCharacters = await embeddingCharacterLimit(endpoints.embedUrl)
  const chunks = await loadCorpus(repositoryRoot, docMaxCharacters)
  await validateQueries(repositoryRoot, chunks)
  await probeEndpoints(endpoints)

  const startedAt = performance.now()
  const queries: LabelledQuery[] = [...CODE_QUERIES, ...DOC_QUERIES]
  const documents = chunks.map(chunkDocument)
  const corpusVectors = await embedBatches(endpoints.embedUrl, documents)
  const queryVectors = await embedBatches(
    endpoints.embedUrl,
    queries.map((query) => query.query),
  )
  const embeddingRankings: Ranking[] = []
  const rerankedRankings: Ranking[] = []
  const keywordRankings: Ranking[] = []

  for (const [index, query] of queries.entries()) {
    const embedded = rankByEmbedding(chunks, corpusVectors, queryVectors[index] ?? [])
    embeddingRankings.push({ queryId: query.id, chunks: embedded, goldLabels: query.goldLabels })

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
    rerankedRankings.push({ queryId: query.id, chunks: reranked, goldLabels: query.goldLabels })

    keywordRankings.push({
      queryId: query.id,
      chunks: await keywordRanking(query.query, chunks),
      goldLabels: query.goldLabels,
    })
  }

  const rankingsFor = (querySet: LabelledQuery[]) => {
    const ids = new Set(querySet.map((query) => query.id))
    return {
      keyword: keywordRankings.filter((ranking) => ids.has(ranking.queryId)),
      embeddings: embeddingRankings.filter((ranking) => ids.has(ranking.queryId)),
      reranked: rerankedRankings.filter((ranking) => ids.has(ranking.queryId)),
    }
  }

  console.log(
    JSON.stringify(
      {
        corpus: {
          codeUnits: new Set(
            chunks.filter((chunk) => chunk.identity.kind === 'code').map((chunk) => chunk.path),
          ).size,
          docs: new Set(
            chunks.filter((chunk) => chunk.identity.kind === 'doc').map((chunk) => chunk.path),
          ).size,
          chunks: chunks.length,
          chunking: {
            code: '60-line windows with 10-line overlap',
            docs: `character windows capped at ${docMaxCharacters} characters from served model metadata`,
            embeddingInput: 'path and start line prefix each document',
          },
        },
        querySets: {
          code: reportSet(CODE_QUERIES, rankingsFor(CODE_QUERIES)),
          docs: reportSet(DOC_QUERIES, rankingsFor(DOC_QUERIES)),
        },
        keywordMethod:
          'ripgrep finds case-insensitive non-stopword query terms; chunks rank by distinct matched terms',
        durationSeconds: (performance.now() - startedAt) / 1000,
      },
      null,
      2,
    ),
  )
}

await main()
