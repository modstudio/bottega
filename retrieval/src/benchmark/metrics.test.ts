import { describe, expect, test } from 'bun:test'
import type { Chunk } from '../corpus/chunks.ts'
import { scoreRankings } from './metrics.ts'

const chunk = (path: string, id: string): Chunk => ({
  id,
  path,
  identity: { kind: 'code', path },
  startLine: 1,
  endLine: 1,
  text: id,
})

describe('scoreRankings', () => {
  test('computes recall and reciprocal rank by gold file', () => {
    const metrics = scoreRankings([
      {
        queryId: 'first',
        goldLabels: ['gold.ts'],
        chunks: [chunk('gold.ts', 'a'), chunk('other.ts', 'b')],
      },
      {
        queryId: 'third',
        goldLabels: ['gold.ts'],
        chunks: [chunk('one.ts', 'c'), chunk('two.ts', 'd'), chunk('gold.ts', 'e')],
      },
      {
        queryId: 'missing',
        goldLabels: ['gold.ts'],
        chunks: [chunk('other.ts', 'f')],
      },
    ])

    expect(metrics).toEqual({ hitAt1: 1 / 3, hitAt5: 2 / 3, mrr: 4 / 9 })
  })

  test('computes hits and reciprocal rank over multiple doc labels', () => {
    const docChunk = (scope: string, subject: string | null, slug: string, id: string): Chunk => ({
      id,
      path: `doc:${scope}/${subject ?? '_'}/${slug}`,
      identity: { kind: 'doc', scope, subject, slug },
      startLine: 1,
      endLine: 1,
      text: id,
    })

    const metrics = scoreRankings([
      {
        queryId: 'two-valid-docs',
        goldLabels: ['doc:project/subject/first', 'doc:global/_/second'],
        chunks: [
          docChunk('machine', null, 'other', 'other'),
          docChunk('global', null, 'second', 'answer'),
        ],
      },
      {
        queryId: 'missing-doc',
        goldLabels: ['doc:agent/codex/missing'],
        chunks: [docChunk('agent', 'codex', 'different', 'different')],
      },
    ])

    expect(metrics).toEqual({ hitAt1: 0, hitAt5: 1 / 2, mrr: 1 / 4 })
  })
})
