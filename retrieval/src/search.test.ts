import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chunk, DocIdentity } from './corpus/chunks.ts'
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
  docStatus: 'current',
})

const addressedChunk = (
  scope: string,
  subject: string,
  id: string,
): Chunk & { identity: DocIdentity } => ({
  ...chunk(id),
  path: `doc:${scope}/${subject}/${id}`,
  identity: { kind: 'doc', scope, subject, slug: id },
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

    expect(result.refresh).toEqual({ embedded: 1, deleted: 0, unchanged: 0, stale: 0 })
    expect(Array.from(result.results[0]!.snippet)).toHaveLength(500)
    expect(result.results[0]).toMatchObject({ truncated: true, rerankScore: 0.9 })
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('filters indexed rows before candidate selection without narrowing refresh', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-filter-test-'))
  const chunks = [
    addressedChunk('project', 'alpha', 'project-alpha'),
    addressedChunk('project', 'beta', 'project-beta'),
    addressedChunk('canon', 'alpha', 'canon-alpha'),
    addressedChunk('canon', 'beta', 'canon-beta'),
  ]
  const clients = {
    embed: async (_url: string, input: string[]) =>
      input.map(() => [1, ...Array.from<number>({ length: 1_023 }).fill(0)]),
    rerank: async (_url: string, _query: string, documents: string[]) =>
      documents.map((_document, index) => documents.length - index),
  }
  const cases = [
    { name: 'all', filter: {}, expected: chunks.map(({ identity }) => identity) },
    {
      name: 'scope',
      filter: { scope: 'project' },
      expected: chunks
        .filter(({ identity }) => identity.kind === 'doc' && identity.scope === 'project')
        .map(({ identity }) => identity),
    },
    {
      name: 'subject',
      filter: { subject: 'alpha' },
      expected: chunks
        .filter(({ identity }) => identity.kind === 'doc' && identity.subject === 'alpha')
        .map(({ identity }) => identity),
    },
    {
      name: 'both',
      filter: { scope: 'canon', subject: 'beta' },
      expected: chunks
        .filter(
          ({ identity }) =>
            identity.kind === 'doc' && identity.scope === 'canon' && identity.subject === 'beta',
        )
        .map(({ identity }) => identity),
    },
  ]
  try {
    for (const scenario of cases) {
      const result = await search('question', 5, {
        repositoryRoot: '/unused',
        databasePath: join(directory, `${scenario.name}.db`),
        loadChunks: async () => chunks,
        clients,
        ...scenario.filter,
      })
      expect(result.refresh).toEqual({ embedded: 4, deleted: 0, unchanged: 0, stale: 0 })
      const addresses = result.results
        .map(({ scope, subject, slug }) => ({ kind: 'doc' as const, scope, subject, slug }))
        .sort((left, right) => left.slug.localeCompare(right.slug))
      expect(addresses).toEqual(
        scenario.expected.toSorted((left, right) => left.slug.localeCompare(right.slug)),
      )
    }
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('drafts are indexed but absent by default and returned when requested', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-draft-filter-test-'))
  const chunks = [
    chunk('current', 'current answer'),
    { ...chunk('draft', 'draft answer'), docStatus: 'draft' as const },
  ]
  const clients = {
    embed: async (_url: string, input: string[]) =>
      input.map(() => [1, ...Array.from<number>({ length: 1_023 }).fill(0)]),
    rerank: async (_url: string, _query: string, documents: string[]) =>
      documents.map((_document, index) => documents.length - index),
  }
  try {
    const databasePath = join(directory, 'retrieval.db')
    const current = await search('answer', 5, {
      databasePath,
      loadChunks: async () => chunks,
      clients,
    })
    expect(current.results.map((result) => result.status)).toEqual(['current'])

    const withDrafts = await search('answer', 5, {
      databasePath,
      loadChunks: async () => chunks,
      clients,
      includeDrafts: true,
    })
    expect(withDrafts.results.map((result) => result.status).sort()).toEqual(['current', 'draft'])
  } finally {
    rmSync(directory, { recursive: true })
  }
})
