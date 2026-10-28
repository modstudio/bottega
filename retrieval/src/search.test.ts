import { Database } from 'bun:sqlite'
import { expect, spyOn, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Chunk, chunkDocument, type DocIdentity } from './corpus/chunks.ts'
import { indexedRows, openIndexDatabase } from './index-store.ts'
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
    'embedding endpoint could not be established at http://embed/v1/embeddings: connection refused. Run `bin/retrieval-search --check` and retry. Configure the endpoints with BOTTEGA_EMBED_URL and BOTTEGA_RERANK_URL.',
  )
  try {
    await expect(
      search('question', 1, {
        repositoryRoot: '/unused',
        databasePath: join(directory, 'retrieval.db'),
        environment: {
          BOTTEGA_EMBED_URL: 'http://embed/v1',
          BOTTEGA_RERANK_URL: 'http://rerank/v1',
        },
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

test('searches a read-only index without refreshing it', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-readonly-search-test-'))
  const databasePath = join(directory, 'retrieval.db')
  const embeddingInputs: string[][] = []
  const clients = {
    embed: async (_url: string, input: string[]) => {
      embeddingInputs.push(input)
      return input.map(() => [1, ...Array.from<number>({ length: 1_023 }).fill(0)])
    },
    rerank: async (_url: string, _query: string, documents: string[]) =>
      documents.map((_document, index) => documents.length - index),
  }
  const stderr = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await search('seed', 2, {
      databasePath,
      loadChunks: async () => [chunk('changed', 'old'), chunk('deleted')],
      clients,
    })
    const legacy = new Database(databasePath)
    legacy.exec('ALTER TABLE document_vector DROP COLUMN status')
    legacy.close()
    embeddingInputs.length = 0
    chmodSync(databasePath, 0o444)
    chmodSync(directory, 0o555)

    const result = await search('question', 2, {
      databasePath,
      loadChunks: async () => [chunk('changed', 'new'), chunk('added')],
      clients,
    })

    expect(result.refresh).toEqual({ embedded: 0, deleted: 0, unchanged: 0, stale: 0 })
    expect(result.results).toHaveLength(2)
    expect(embeddingInputs).toHaveLength(1)
    expect(embeddingInputs[0]).toHaveLength(1)
    expect(stderr).toHaveBeenLastCalledWith(
      'retrieval index was not refreshed because this caller cannot write it; 3 chunks are out of date; a writer refreshes it on its next search',
    )
  } finally {
    stderr.mockRestore()
    chmodSync(directory, 0o755)
    if (existsSync(databasePath)) chmodSync(databasePath, 0o644)
    rmSync(directory, { recursive: true })
  }
})

test('refuses when a read-only caller has no existing index', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-readonly-missing-test-'))
  const databasePath = join(directory, 'retrieval.db')
  chmodSync(directory, 0o555)
  try {
    await expect(
      search('question', 1, {
        databasePath,
        loadChunks: async () => [chunk('one')],
        clients: { embed: async () => [], rerank: async () => [] },
      }),
    ).rejects.toThrow(
      'there is no retrieval index yet; a search from a session that can write the state directory builds it',
    )
  } finally {
    chmodSync(directory, 0o755)
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

test('a pre-status index is readable as current and a refresh repairs draft status', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-legacy-status-test-'))
  const databasePath = join(directory, 'retrieval.db')
  const { docStatus: _legacyStatus, ...legacyChunk } = chunk('legacy-draft', 'draft answer')
  const draft = { ...legacyChunk, docStatus: 'draft' as const }
  const document = chunkDocument(legacyChunk)
  const contentHash = createHash('sha256').update(document).digest('hex')
  const vector = new Uint8Array(new Float32Array([1, ...Array(1_023).fill(0)]).buffer)
  const legacy = new Database(databasePath, { create: true })
  legacy.exec(`
    CREATE TABLE document_vector (
      chunk_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, model TEXT NOT NULL,
      dimension INTEGER NOT NULL, instruction_version TEXT NOT NULL,
      corpus_key TEXT NOT NULL DEFAULT 'docs', project TEXT, repository_path TEXT,
      start_line INTEGER, end_line INTEGER, scope TEXT NOT NULL, subject TEXT,
      slug TEXT NOT NULL, title TEXT NOT NULL, heading_path TEXT NOT NULL,
      text TEXT NOT NULL, document TEXT NOT NULL, vector BLOB NOT NULL
    )
  `)
  legacy
    .query(
      `INSERT INTO document_vector
       (chunk_id, content_hash, model, dimension, instruction_version, scope, subject, slug,
        title, heading_path, text, document, vector)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      draft.id,
      contentHash,
      'Qwen/Qwen3-Embedding-0.6B',
      1_024,
      'doc-search-v2',
      'project',
      'p',
      'doc',
      'Doc',
      '[]',
      draft.text,
      document,
      vector,
    )
  legacy.close()
  const clients = {
    embed: async (_url: string, input: string[]) =>
      input.map(() => [1, ...Array.from<number>({ length: 1_023 }).fill(0)]),
    rerank: async (_url: string, _query: string, documents: string[]) =>
      documents.map((_document, index) => documents.length - index),
  }
  try {
    const before = openIndexDatabase(databasePath)
    expect(indexedRows(before)[0]?.status).toBe('current')
    before.close()

    const legacySearch = await search('answer', 5, {
      databasePath,
      loadChunks: async () => [legacyChunk],
      clients,
    })
    expect(legacySearch.refresh.unchanged).toBe(1)
    expect(legacySearch.results[0]?.status).toBe('current')

    const refreshed = await search('answer', 5, {
      databasePath,
      loadChunks: async () => [draft],
      clients,
    })
    expect(refreshed.refresh.embedded).toBe(1)
    expect(refreshed.results).toEqual([])

    const withDrafts = await search('answer', 5, {
      databasePath,
      loadChunks: async () => [draft],
      clients,
      includeDrafts: true,
    })
    expect(withDrafts.refresh.unchanged).toBe(1)
    expect(withDrafts.results[0]?.status).toBe('draft')
  } finally {
    rmSync(directory, { recursive: true })
  }
})
