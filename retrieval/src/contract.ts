// concern: retrieval-contract
/** Defines the embedding contract whose changes invalidate stored vectors. */

export const EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-0.6B'
export const EMBEDDING_DIMENSION = 1_024
export const QUERY_TASK = 'Given a question, retrieve document passages that answer it.'
export const INSTRUCTION_VERSION = 'doc-search-v1'
export const RERANK_CANDIDATES = 20

export function queryDocument(query: string): string {
  return `Instruct: ${QUERY_TASK}\nQuery:${query}`
}
