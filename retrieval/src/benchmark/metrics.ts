// concern: retrieval-metrics
/** Scores ranked chunks against the file that contains each query's gold answer. */
import type { Chunk } from '../corpus/chunks.ts'

export type Ranking = { queryId: string; chunks: Chunk[]; goldPath: string }
type RetrievalMetrics = { recallAt1: number; recallAt5: number; mrr: number }

export function scoreRankings(rankings: Ranking[]): RetrievalMetrics {
  if (!rankings.length) return { recallAt1: 0, recallAt5: 0, mrr: 0 }
  let hitsAt1 = 0
  let hitsAt5 = 0
  let reciprocalRanks = 0
  for (const ranking of rankings) {
    const first = ranking.chunks.findIndex((chunk) => chunk.path === ranking.goldPath)
    if (first === 0) hitsAt1 += 1
    if (first >= 0 && first < 5) hitsAt5 += 1
    if (first >= 0) reciprocalRanks += 1 / (first + 1)
  }
  return {
    recallAt1: hitsAt1 / rankings.length,
    recallAt5: hitsAt5 / rankings.length,
    mrr: reciprocalRanks / rankings.length,
  }
}
