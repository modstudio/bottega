import { describe, expect, test } from 'bun:test'
import type { Chunk } from '../corpus/chunks.ts'
import { scoreRankings } from './metrics.ts'

const chunk = (path: string, id: string): Chunk => ({
  id,
  path,
  startLine: 1,
  endLine: 1,
  text: id,
})

describe('scoreRankings', () => {
  test('computes recall and reciprocal rank by gold file', () => {
    const metrics = scoreRankings([
      {
        queryId: 'first',
        goldPath: 'gold.ts',
        chunks: [chunk('gold.ts', 'a'), chunk('other.ts', 'b')],
      },
      {
        queryId: 'third',
        goldPath: 'gold.ts',
        chunks: [chunk('one.ts', 'c'), chunk('two.ts', 'd'), chunk('gold.ts', 'e')],
      },
      {
        queryId: 'missing',
        goldPath: 'gold.ts',
        chunks: [chunk('other.ts', 'f')],
      },
    ])

    expect(metrics).toEqual({ recallAt1: 1 / 3, recallAt5: 2 / 3, mrr: 4 / 9 })
  })
})
