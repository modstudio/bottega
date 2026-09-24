import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chunk } from './corpus/chunks.ts'
import { search } from './search.ts'

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

test('refuses an unreachable embedding endpoint through an injected client', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-index-test-'))
  const absent = new Error(
    'embedding endpoint could not be established at http://embed/v1/embeddings: connection refused. Run `bin/retrieval-search --check` and retry. Configure the endpoints with ORCH_EMBED_URL and ORCH_RERANK_URL.',
  )
  try {
    await expect(
      search('question', 1, {
        repositoryRoot: '/unused',
        databasePath: join(directory, 'retrieval.db'),
        environment: { ORCH_EMBED_URL: 'http://embed/v1', ORCH_RERANK_URL: 'http://rerank/v1' },
        loadChunks: async () => [chunk('one')],
        clients: { embed: async () => Promise.reject(absent), rerank: async () => [] },
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
