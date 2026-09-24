// concern: retrieval-metrics
/** Scores ranked chunks against the code or doc identities that answer each query. */
import type { Chunk } from '../corpus/chunks.ts'
import { docIdentity } from '../corpus/chunks.ts'

export type Ranking = { queryId: string; chunks: Chunk[]; goldLabels: string[] }
type RetrievalMetrics = { hitAt1: number; hitAt5: number; mrr: number }

function chunkLabel(chunk: Chunk): string {
  return chunk.identity.kind === 'code' ? chunk.identity.path : docIdentity(chunk.identity)
}

export function rankOfFirstLabel(ranking: Ranking): number {
  const labels = new Set(ranking.goldLabels)
  return ranking.chunks.findIndex((chunk) => labels.has(chunkLabel(chunk)))
}

export function scoreRankings(rankings: Ranking[]): RetrievalMetrics {
  if (!rankings.length) return { hitAt1: 0, hitAt5: 0, mrr: 0 }
  let hitsAt1 = 0
  let hitsAt5 = 0
  let reciprocalRanks = 0
  for (const ranking of rankings) {
    const first = rankOfFirstLabel(ranking)
    if (first === 0) hitsAt1 += 1
    if (first >= 0 && first < 5) hitsAt5 += 1
    if (first >= 0) reciprocalRanks += 1 / (first + 1)
  }
  return {
    hitAt1: hitsAt1 / rankings.length,
    hitAt5: hitsAt5 / rankings.length,
    mrr: reciprocalRanks / rankings.length,
  }
}
