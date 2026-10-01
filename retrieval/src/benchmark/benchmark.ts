// concern: retrieval-benchmark
/** Runs the live, non-gating comparison of embeddings, reranking, and ripgrep. */
import { access, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { searchCode } from '../code-search.ts'
import { queryDocument, RERANK_CANDIDATES } from '../contract.ts'
import {
  type Chunk,
  chunkDocument,
  loadCorpus,
  loadDocRows,
  splitChunksToModelLimit,
} from '../corpus/chunks.ts'
import { search } from '../search.ts'
import {
  embed,
  endpointsFromEnvironment,
  probeEndpoints,
  rerank,
  tokenize,
} from '../services/endpoints.ts'
import { cosineTopK } from '../vector-ranking.ts'
import { checkDocPins } from './doc-pins.ts'
import { keywordRanking } from './keyword.ts'
import { type Ranking, rankOfFirstLabel, scoreRankings } from './metrics.ts'
import {
  type BenchmarkQuery,
  CODE_QUERIES,
  DOC_QUERIES,
  type DocBenchmarkQuery,
  type LabeledQuery,
  REAL_CODE_QUERIES,
} from './queries.ts'

const EMBED_BATCH_SIZE = 64

function rankByEmbedding(chunks: Chunk[], vectors: number[][], queryVector: number[]): Chunk[] {
  const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]))
  return cosineTopK(
    chunks.map((chunk, index) => ({ id: chunk.id, vector: vectors[index] ?? [] })),
    queryVector,
    chunks.length,
  ).map(({ id }) => byId.get(id)!)
}

async function embedBatches(url: string, documents: string[]): Promise<number[][]> {
  const vectors: number[][] = []
  for (let start = 0; start < documents.length; start += EMBED_BATCH_SIZE) {
    vectors.push(...(await embed(url, documents.slice(start, start + EMBED_BATCH_SIZE))))
  }
  return vectors
}

async function validateQueries(repositoryRoot: string, chunks: Chunk[]): Promise<void> {
  const codeChunkPaths = new Set(
    chunks.filter((chunk) => chunk.identity.kind === 'code').map((chunk) => chunk.path),
  )
  const validateCodeSet = async (name: string, queries: BenchmarkQuery[]) => {
    if (queries.length < 20 || queries.length > 40) {
      throw new Error(`${name} benchmark requires 20 to 40 queries; found ${queries.length}`)
    }
    for (const query of queries) {
      if (!query.goldLabels.length) throw new Error(`${query.id} has no code label`)
      for (const goldPath of query.goldLabels) {
        await access(resolve(repositoryRoot, goldPath))
        if (!codeChunkPaths.has(goldPath)) {
          throw new Error(`${query.id} code label is absent from the corpus: ${goldPath}`)
        }
      }
      const source = await readFile(resolve(repositoryRoot, query.provenance.path), 'utf8')
      const plainSource = source.replace(/[`*_]/g, '').replace(/\s+/g, ' ')
      const excerpt = query.provenance.excerpt.replace(/\s+/g, ' ')
      if (!plainSource.includes(excerpt)) {
        throw new Error(`${query.id} provenance excerpt is absent from ${query.provenance.path}`)
      }
    }
  }
  await validateCodeSet('code', CODE_QUERIES)
  await validateCodeSet('real code', REAL_CODE_QUERIES)
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
  queries: LabeledQuery[],
  rankings: {
    keyword: Ranking[]
    embeddings: Ranking[]
    reranked: Ranking[]
    index?: Ranking[]
    codeIndex?: Ranking[]
    codeIndexExcludeTests?: Ranking[]
    codeIndexDownrankTests?: Ranking[]
  },
) {
  const missedIds = rankings.keyword
    .filter((ranking) => rankOfFirstLabel(ranking) < 0 || rankOfFirstLabel(ranking) >= 5)
    .map((ranking) => ranking.queryId)
    .filter((queryId) =>
      [
        rankings.embeddings,
        rankings.reranked,
        ...(rankings.index ? [rankings.index] : []),
        ...(rankings.codeIndex ? [rankings.codeIndex] : []),
        ...(rankings.codeIndexExcludeTests ? [rankings.codeIndexExcludeTests] : []),
        ...(rankings.codeIndexDownrankTests ? [rankings.codeIndexDownrankTests] : []),
      ].every((method) => {
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
      ...(rankings.index ? { index: scoreRankings(rankings.index) } : {}),
      ...(rankings.codeIndex ? { codeIndex: scoreRankings(rankings.codeIndex) } : {}),
      ...(rankings.codeIndexExcludeTests
        ? { codeIndexExcludeTests: scoreRankings(rankings.codeIndexExcludeTests) }
        : {}),
      ...(rankings.codeIndexDownrankTests
        ? { codeIndexDownrankTests: scoreRankings(rankings.codeIndexDownrankTests) }
        : {}),
    },
    missedByEveryMethodAt5: queries
      .filter((query) => missedIds.includes(query.id))
      .map(({ id, query, goldLabels }) => ({ id, query, goldLabels })),
  }
}

async function main() {
  const repositoryRoot = resolve(import.meta.dir, '../../..')
  if (process.argv.includes('--check-doc-pins')) {
    const pins = checkDocPins(DOC_QUERIES, await loadDocRows(repositoryRoot))
    console.log(JSON.stringify({ pins }, null, 2))
    if (pins.some((pin) => !pin.current)) process.exitCode = 1
    return
  }
  const endpoints = endpointsFromEnvironment(process.env)
  const chunks = await splitChunksToModelLimit(await loadCorpus(repositoryRoot), (document) =>
    tokenize(endpoints.embedUrl, document),
  )
  await validateQueries(repositoryRoot, chunks)
  await probeEndpoints(endpoints)

  const startedAt = performance.now()
  const queries: LabeledQuery[] = [...CODE_QUERIES, ...REAL_CODE_QUERIES, ...DOC_QUERIES]
  const documents = chunks.map(chunkDocument)
  const corpusVectors = await embedBatches(endpoints.embedUrl, documents)
  const queryVectors = await embedBatches(
    endpoints.embedUrl,
    queries.map((query) => queryDocument(query.query)),
  )
  const embeddingRankings: Ranking[] = []
  const rerankedRankings: Ranking[] = []
  const keywordRankings: Ranking[] = []
  const indexRankings: Ranking[] = []
  const codeIndexRankings: Ranking[] = []
  const codeIndexExcludeTestsRankings: Ranking[] = []
  const codeIndexDownrankTestsRankings: Ranking[] = []

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

  for (const query of DOC_QUERIES) {
    const output = await search(query.query, 5, { repositoryRoot })
    indexRankings.push({
      queryId: query.id,
      goldLabels: query.goldLabels,
      chunks: output.results.map((result, index) => ({
        id: `index:${query.id}:${index}`,
        path: `doc:${result.scope}/${result.subject ?? '_'}/${result.slug}`,
        identity: {
          kind: 'doc' as const,
          scope: result.scope,
          subject: result.subject,
          slug: result.slug,
        },
        startLine: 1,
        endLine: 1,
        text: result.snippet,
      })),
    })
  }

  for (const query of REAL_CODE_QUERIES) {
    for (const [testPolicy, rankings] of [
      ['include', codeIndexRankings],
      ['exclude', codeIndexExcludeTestsRankings],
      ['downrank', codeIndexDownrankTestsRankings],
    ] as const) {
      const output = await searchCode(
        { name: PLATFORM_SLUG, path: repositoryRoot },
        query.query,
        5,
        { testPolicy },
      )
      rankings.push({
        queryId: query.id,
        goldLabels: query.goldLabels,
        chunks: output.results.map((result, index) => ({
          id: `code-index-${testPolicy}:${query.id}:${index}`,
          path: result.path,
          identity: { kind: 'code' as const, path: result.path },
          startLine: result.startLine,
          endLine: result.endLine,
          text: result.snippet,
        })),
      })
    }
  }

  const rankingsFor = (querySet: LabeledQuery[]) => {
    const ids = new Set(querySet.map((query) => query.id))
    const indexed = indexRankings.filter((ranking) => ids.has(ranking.queryId))
    const codeIndexed = codeIndexRankings.filter((ranking) => ids.has(ranking.queryId))
    const codeIndexExcludeTests = codeIndexExcludeTestsRankings.filter((ranking) =>
      ids.has(ranking.queryId),
    )
    const codeIndexDownrankTests = codeIndexDownrankTestsRankings.filter((ranking) =>
      ids.has(ranking.queryId),
    )
    return {
      keyword: keywordRankings.filter((ranking) => ids.has(ranking.queryId)),
      embeddings: embeddingRankings.filter((ranking) => ids.has(ranking.queryId)),
      reranked: rerankedRankings.filter((ranking) => ids.has(ranking.queryId)),
      ...(indexed.length ? { index: indexed } : {}),
      ...(codeIndexed.length ? { codeIndex: codeIndexed } : {}),
      ...(codeIndexExcludeTests.length ? { codeIndexExcludeTests } : {}),
      ...(codeIndexDownrankTests.length ? { codeIndexDownrankTests } : {}),
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
            docs: 'markdown sections, split near 2,000 characters at paragraph and line boundaries',
            modelLimit: 'every prefixed chunk verified with the embedding model tokenizer',
            embeddingInput: 'path and start line prefix each document',
          },
        },
        querySets: {
          code: reportSet(CODE_QUERIES, rankingsFor(CODE_QUERIES)),
          realCode: reportSet(REAL_CODE_QUERIES, rankingsFor(REAL_CODE_QUERIES)),
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
