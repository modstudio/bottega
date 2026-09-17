// concern: retrieval-endpoints
/** Probes and calls the two OpenAI-compatible retrieval services. */

const EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-0.6B'
const RERANK_MODEL = 'Qwen/Qwen3-Reranker-0.6B'
const DEFAULT_EMBED_URL = 'http://127.0.0.1:8011/v1'
const DEFAULT_RERANK_URL = 'http://127.0.0.1:8012/v1'

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type EmbeddingResponse = { data?: Array<{ index: number; embedding: number[] }> }
type RerankResponse = { results?: Array<{ index: number; relevance_score: number }> }

type RetrievalEndpoints = { embedUrl: string; rerankUrl: string }

export function endpointsFromEnvironment(environment: NodeJS.ProcessEnv): RetrievalEndpoints {
  return {
    embedUrl: environment.ORCH_EMBED_URL ?? DEFAULT_EMBED_URL,
    rerankUrl: environment.ORCH_RERANK_URL ?? DEFAULT_RERANK_URL,
  }
}

function refusal(kind: string, url: string, detail: string): Error {
  return new Error(
    `${kind} endpoint could not be established at ${url}: ${detail}. ` +
      'Run `launchctl kickstart -k gui/$(id -u)/com.user.gx10-services-tunnel` and retry.',
  )
}

async function postJson<T>(kind: string, url: string, body: unknown, fetcher: Fetch): Promise<T> {
  let response: Response
  try {
    response = await fetcher(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    throw refusal(kind, url, error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) throw refusal(kind, url, `HTTP ${response.status}`)
  try {
    return (await response.json()) as T
  } catch (error) {
    throw refusal(
      kind,
      url,
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function embed(
  baseUrl: string,
  input: string[],
  fetcher: Fetch = fetch,
): Promise<number[][]> {
  const response = await postJson<EmbeddingResponse>(
    'embedding',
    `${baseUrl.replace(/\/$/, '')}/embeddings`,
    { model: EMBEDDING_MODEL, input },
    fetcher,
  )
  if (!response.data || response.data.length !== input.length) {
    throw refusal('embedding', baseUrl, 'response did not contain one vector per input')
  }
  return response.data.sort((left, right) => left.index - right.index).map((row) => row.embedding)
}

export async function rerank(
  baseUrl: string,
  query: string,
  documents: string[],
  fetcher: Fetch = fetch,
): Promise<number[]> {
  const response = await postJson<RerankResponse>(
    'reranking',
    `${baseUrl.replace(/\/$/, '')}/rerank`,
    { model: RERANK_MODEL, query, documents },
    fetcher,
  )
  if (!response.results || response.results.length !== documents.length) {
    throw refusal('reranking', baseUrl, 'response did not contain one score per document')
  }
  const scores = Array.from<number>({ length: documents.length }).fill(Number.NEGATIVE_INFINITY)
  for (const result of response.results) scores[result.index] = result.relevance_score
  return scores
}

export async function probeEndpoints(
  endpoints: RetrievalEndpoints,
  fetcher: Fetch = fetch,
): Promise<void> {
  await embed(endpoints.embedUrl, ['retrieval endpoint probe'], fetcher)
  await rerank(endpoints.rerankUrl, 'retrieval endpoint probe', ['probe document'], fetcher)
}
