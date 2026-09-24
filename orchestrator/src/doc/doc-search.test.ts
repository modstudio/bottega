import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { searchDocs } from './doc-search.ts'

test('orch adapter parses the retrieval JSON contract', async () => {
  const output = {
    query: 'meaning',
    k: 1,
    contract: { model: 'model', dimension: 1024, instructionVersion: 'doc-search-v1' },
    refresh: { embedded: 2, deleted: 1, unchanged: 3 },
    results: [
      {
        scope: 'project',
        subject: PLATFORM_SLUG,
        slug: 'design',
        title: 'Design',
        headingPath: ['Why'],
        snippet: 'answer',
        truncated: false,
        embeddingScore: 0.75,
        rerankScore: 0.9,
      },
    ],
  }
  const seen: string[][] = []
  const result = await searchDocs('meaning', 1, async (argv) => {
    seen.push(argv)
    return { stdout: JSON.stringify(output), stderr: '', exitCode: 0 }
  })

  expect(seen).toEqual([['meaning', '--k', '1', '--json']])
  expect(result).toEqual(output)
})

test('orch adapter refuses malformed or failed retrieval output', async () => {
  await expect(
    searchDocs('meaning', 1, async () => ({ stdout: '{}', stderr: '', exitCode: 0 })),
  ).rejects.toThrow('invalid JSON contract')
  await expect(
    searchDocs('meaning', 1, async () => ({ stdout: '', stderr: 'endpoint absent', exitCode: 1 })),
  ).rejects.toThrow('endpoint absent')
})
