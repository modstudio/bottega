import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { checkRetrieval, searchDocs } from './doc-search.ts'
import { searchDocs as searchDocService } from './doc-search-service.ts'

test('orchestrator adapter parses the retrieval JSON contract', async () => {
  const output = {
    query: 'meaning',
    k: 1,
    contract: { model: 'model', dimension: 1024, instructionVersion: 'doc-search-v1' },
    refresh: { embedded: 2, deleted: 1, unchanged: 3, stale: 0 },
    results: [
      {
        scope: 'project',
        subject: PLATFORM_SLUG,
        slug: 'design',
        title: 'Design',
        status: 'current' as const,
        headingPath: ['Why'],
        snippet: 'answer',
        truncated: false,
        embeddingScore: 0.75,
        rerankScore: 0.9,
      },
    ],
  }
  const seen: string[][] = []
  const result = await searchDocs('meaning', 1, {}, async (argv) => {
    seen.push(argv)
    return { stdout: JSON.stringify(output), stderr: '', exitCode: 0 }
  })

  expect(seen).toEqual([['meaning', '--k', '1', '--json']])
  expect(result).toEqual(output)
  await expect(
    searchDocService(
      'meaning',
      1,
      {},
      async () => output,
      () => null,
    ),
  ).resolves.toEqual({
    ...output,
    results: output.results.map((row) => ({
      ...row,
      summary: '',
      summarySource: 'derived',
    })),
  })
  await expect(
    searchDocService(
      'meaning',
      1,
      {},
      async () => output,
      () => ({ summary: 'Written search summary.', body: 'Derived body.' }) as never,
    ),
  ).resolves.toMatchObject({
    results: [{ summary: 'Written search summary.', summarySource: 'written' }],
  })
})

test('orchestrator adapter forwards optional document address filters', async () => {
  const seen: string[][] = []
  const output = {
    query: 'meaning',
    k: 2,
    contract: { model: 'model', dimension: 1024, instructionVersion: 'doc-search-v1' },
    refresh: { embedded: 0, deleted: 0, unchanged: 0, stale: 0 },
    results: [],
  }
  const runner = async (argv: string[]) => {
    seen.push(argv)
    return { stdout: JSON.stringify(output), stderr: '', exitCode: 0 }
  }

  await searchDocs('meaning', 2, {}, runner)
  await searchDocs('meaning', 2, { scope: 'canon' }, runner)
  await searchDocs('meaning', 2, { subject: PLATFORM_SLUG }, runner)
  await searchDocs('meaning', 2, { scope: 'canon', subject: PLATFORM_SLUG }, runner)
  await searchDocs('meaning', 2, { includeDrafts: true }, runner)

  expect(seen).toEqual([
    ['meaning', '--k', '2', '--json'],
    ['meaning', '--k', '2', '--json', '--scope', 'canon'],
    ['meaning', '--k', '2', '--json', '--subject', PLATFORM_SLUG],
    ['meaning', '--k', '2', '--json', '--scope', 'canon', '--subject', PLATFORM_SLUG],
    ['meaning', '--k', '2', '--json', '--include-drafts'],
  ])
})

test('orchestrator adapter refuses malformed or failed retrieval output', async () => {
  await expect(
    searchDocs('meaning', 1, {}, async () => ({ stdout: '{}', stderr: '', exitCode: 0 })),
  ).rejects.toThrow('invalid JSON contract')
  await expect(
    searchDocs('meaning', 1, {}, async () => ({
      stdout: '',
      stderr: 'endpoint absent',
      exitCode: 1,
    })),
  ).rejects.toThrow('endpoint absent')
})

test('orchestrator adapter checks retrieval through the same executable boundary', async () => {
  const seen: string[][] = []
  const output = await checkRetrieval(async (argv) => {
    seen.push(argv)
    return { stdout: 'embedding http://embed/v1 reachable\n', stderr: '', exitCode: 0 }
  })
  expect(seen).toEqual([['--check']])
  expect(output.exitCode).toBe(0)
})
