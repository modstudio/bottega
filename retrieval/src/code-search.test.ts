import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchCode } from './code-search.ts'
import type { Chunk } from './corpus/chunks.ts'

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
