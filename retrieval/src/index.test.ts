import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chunk } from './corpus/chunks.ts'
import { cosineTopK, planRefresh, search } from './index.ts'

const chunk = (id: string, text = id): Chunk => ({
  id,
  path: 'doc:project/p/doc',
  identity: { kind: 'doc', scope: 'project', subject: 'p', slug: 'doc' },
  startLine: 1,
  endLine: 1,
  text,
  docTitle: 'Doc',
  headingPath: [],
})

const stored = (
  chunkId: string,
  contentHash: string,
  overrides: Partial<{
    model: string
    dimension: number
    instructionVersion: string
  }> = {},
) => ({
  chunkId,
  contentHash,
  model: 'Qwen/Qwen3-Embedding-0.6B',
  dimension: 1_024,
  instructionVersion: 'doc-search-v1',
  ...overrides,
})

describe('retrieval index', () => {
  test('plans new, changed, vanished, unchanged, and contract-mismatch rows', () => {
    const current = [
      { chunk: chunk('new'), contentHash: 'new-hash' },
      { chunk: chunk('changed'), contentHash: 'changed-hash' },
      { chunk: chunk('same'), contentHash: 'same-hash' },
      { chunk: chunk('contract'), contentHash: 'contract-hash' },
    ]
    const plan = planRefresh(current, [
      stored('changed', 'old-hash'),
      stored('same', 'same-hash'),
      stored('contract', 'contract-hash', { instructionVersion: 'old' }),
      stored('vanished', 'gone'),
    ])

    expect(plan.embed.map(({ chunk: value }) => value.id)).toEqual(['changed', 'contract', 'new'])
    expect(plan.delete).toEqual(['vanished'])
    expect(plan.unchanged).toEqual(['same'])
  })

  test('orders fixed vectors by exact cosine with stable ties', () => {
    expect(
      cosineTopK(
        [
          { id: 'orthogonal', vector: new Float32Array([0, 1]) },
          { id: 'same-b', vector: new Float32Array([2, 0]) },
          { id: 'same-a', vector: new Float32Array([1, 0]) },
        ],
        new Float32Array([1, 0]),
        3,
      ).map(({ id }) => id),
    ).toEqual(['same-a', 'same-b', 'orthogonal'])
  })

  test('refuses an unreachable embedding endpoint through an injected client', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'retrieval-index-test-'))
    const absent = new Error(
      'embedding endpoint could not be established at http://embed/v1/embeddings: connection refused. Run `orch doctor` to check model-host reachability and retry.',
    )
    try {
      await expect(
        search('question', 1, {
          repositoryRoot: '/unused',
          databasePath: join(directory, 'retrieval.db'),
          environment: { ORCH_EMBED_URL: 'http://embed/v1', ORCH_RERANK_URL: 'http://rerank/v1' },
          loadChunks: async () => [chunk('one')],
          clients: {
            embed: async () => Promise.reject(absent),
            rerank: async () => [],
          },
        }),
      ).rejects.toThrow('http://embed/v1/embeddings')
    } finally {
      rmSync(directory, { recursive: true })
    }
  })

  test('refreshes and searches the SQLite Float32 index with bounded Unicode snippets', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'retrieval-search-test-'))
    const text = '🙂'.repeat(501)
    try {
      const result = await search('question', 1, {
        repositoryRoot: '/unused',
        databasePath: join(directory, 'retrieval.db'),
        loadChunks: async () => [chunk('one', text)],
        clients: {
          embed: async (_url, input) =>
            input.map(() => [1, ...Array.from<number>({ length: 1_023 }).fill(0)]),
          rerank: async () => [0.9],
        },
      })

      expect(result.refresh).toEqual({ embedded: 1, deleted: 0, unchanged: 0 })
      expect(Array.from(result.results[0]!.snippet)).toHaveLength(500)
      expect(result.results[0]).toMatchObject({ truncated: true, rerankScore: 0.9 })
    } finally {
      rmSync(directory, { recursive: true })
    }
  })
})
