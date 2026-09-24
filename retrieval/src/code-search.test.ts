import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchCode } from './code-search.ts'
import type { Chunk } from './corpus/chunks.ts'
import { applyCodeCacheRefresh, configureIndexDatabase } from './index-store.ts'

const vector = (axis: number): number[] =>
  Array.from({ length: 1_024 }, (_, index) => (index === axis ? 1 : 0))

const chunk = (path: string, text: string): Chunk => ({
  id: `${path}:1-1`,
  path,
  identity: { kind: 'code', path },
  startLine: 1,
  endLine: 1,
  text,
})

test('checkouts share cached vectors, embed only changed chunks, and return caller content', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-code-cache-test-'))
  const databasePath = join(directory, 'retrieval.db')
  const embeddedDocuments: string[] = []
  const clients = {
    embed: async (_url: string, inputs: string[]) =>
      inputs.map((input) => {
        if (!input.startsWith('Instruct:')) embeddedDocuments.push(input)
        return vector(input.includes('branch answer') ? 0 : input.startsWith('Instruct:') ? 0 : 1)
      }),
    rerank: async (_url: string, _query: string, documents: string[]) =>
      documents.map((document) => (document.includes('branch answer') ? 1 : 0)),
  }
  try {
    await searchCode({ name: 'fixture', path: '/checkout-one' }, 'answer', 5, {
      databasePath,
      clients,
      loadChunks: async () => [
        chunk('src/shared.ts', 'shared content'),
        chunk('src/old.ts', 'old answer'),
      ],
    })
    expect(embeddedDocuments).toHaveLength(2)

    const result = await searchCode({ name: 'fixture', path: '/checkout-two' }, 'answer', 5, {
      databasePath,
      clients,
      loadChunks: async (root) => {
        expect(root).toBe('/checkout-two')
        return [chunk('src/shared.ts', 'shared content'), chunk('src/new.ts', 'branch answer')]
      },
    })

    expect(embeddedDocuments).toHaveLength(3)
    expect(result.refresh).toMatchObject({ embedded: 1, unchanged: 1, pruned: 0 })
    expect(result.results[0]).toMatchObject({ path: 'src/new.ts', snippet: 'branch answer' })
    expect(result.results.some(({ path }) => path === 'src/old.ts')).toBe(false)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('a concurrent prune cannot remove a planned expired hit while a miss is embedding', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-code-plan-test-'))
  const databasePath = join(directory, 'retrieval.db')
  const cached = chunk('src/cached.ts', 'cached answer')
  const missing = chunk('src/missing.ts', 'other content')
  const vectors = (inputs: string[]) =>
    inputs.map((input) =>
      vector(input.includes('cached answer') || input.startsWith('Instruct:') ? 0 : 1),
    )
  let second: Database | undefined
  try {
    await searchCode({ name: 'fixture', path: '/checkout' }, 'answer', 2, {
      databasePath,
      now: 1,
      loadChunks: async () => [cached],
      clients: {
        embed: async (_url, inputs) => vectors(inputs),
        rerank: async (_url, _query, documents) => documents.map(() => 1),
      },
    })

    second = new Database(databasePath, { create: true })
    configureIndexDatabase(second)
    let prunedDuringEmbedding: number | undefined
    const result = await searchCode({ name: 'fixture', path: '/checkout' }, 'answer', 2, {
      databasePath,
      now: 100,
      retentionMs: 50,
      loadChunks: async () => [cached, missing],
      clients: {
        embed: async (_url, inputs) => {
          if (inputs.some((input) => !input.startsWith('Instruct:'))) {
            prunedDuringEmbedding = applyCodeCacheRefresh(second!, {
              seenContentHashes: [],
              embedded: [],
              now: 100,
              retentionMs: 50,
            }).pruned
          }
          return vectors(inputs)
        },
        rerank: async (_url, _query, documents) =>
          documents.map((document) => (document.includes('cached answer') ? 1 : 0)),
      },
    })

    expect(prunedDuringEmbedding).toBe(0)
    expect(result.refresh).toMatchObject({ embedded: 1, unchanged: 1 })
    expect(result.results[0]).toMatchObject({ path: 'src/cached.ts', snippet: 'cached answer' })
  } finally {
    second?.close()
    rmSync(directory, { recursive: true })
  }
})

test('a cache row pruned before planning is treated as a miss and embedded', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-code-pruned-test-'))
  const databasePath = join(directory, 'retrieval.db')
  const candidate = chunk('src/pruned.ts', 'pruned answer')
  let second: Database | undefined
  try {
    await searchCode({ name: 'fixture', path: '/checkout' }, 'answer', 1, {
      databasePath,
      now: 1,
      loadChunks: async () => [candidate],
      clients: {
        embed: async (_url, inputs) => inputs.map(() => vector(0)),
        rerank: async () => [1],
      },
    })
    second = new Database(databasePath, { create: true })
    configureIndexDatabase(second)
    expect(
      applyCodeCacheRefresh(second, {
        seenContentHashes: [],
        embedded: [],
        now: 100,
        retentionMs: 50,
      }).pruned,
    ).toBe(1)

    const embeddedDocuments: string[] = []
    const result = await searchCode({ name: 'fixture', path: '/checkout' }, 'answer', 1, {
      databasePath,
      now: 100,
      retentionMs: 50,
      loadChunks: async () => [candidate],
      clients: {
        embed: async (_url, inputs) => {
          embeddedDocuments.push(...inputs.filter((input) => !input.startsWith('Instruct:')))
          return inputs.map(() => vector(0))
        },
        rerank: async () => [1],
      },
    })

    expect(embeddedDocuments).toHaveLength(1)
    expect(embeddedDocuments[0]).toContain('pruned answer')
    expect(result.refresh).toMatchObject({ embedded: 1, unchanged: 0 })
    expect(result.results[0]).toMatchObject({ path: 'src/pruned.ts' })
  } finally {
    second?.close()
    rmSync(directory, { recursive: true })
  }
})
