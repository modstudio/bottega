import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { INSTRUCTION_VERSION } from './contract.ts'
import type { Chunk } from './corpus/chunks.ts'
import {
  applyCodeCacheRefresh,
  applyRefresh,
  configureIndexDatabase,
  indexedRows,
  planCodeCache,
  storedRows,
} from './index-store.ts'
import { planRefresh } from './refresh-plan.ts'

const vector = [1, ...Array.from<number>({ length: 1_023 }).fill(0)]

test('two handles interleave cold schema creation and reject a stale repeated refresh', () => {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-concurrency-test-'))
  const path = join(directory, 'retrieval.db')
  const first = new Database(path, { create: true })
  const second = new Database(path, { create: true })
  try {
    configureIndexDatabase(first)
    configureIndexDatabase(second)
    const chunk: Chunk = {
      id: 'one',
      path: 'doc:project/p/doc',
      identity: { kind: 'doc', scope: 'project', subject: 'p', slug: 'doc' },
      startLine: 1,
      endLine: 1,
      text: 'one',
      docTitle: 'Doc',
      headingPath: [],
    }
    const candidate = { chunk, contentHash: 'hash', observed: null }
    const prepared = {
      corpusKey: 'docs',
      delete: [],
      upsert: [{ ...candidate, document: 'one', vector }],
    }
    expect(applyRefresh(first, prepared)).toEqual({ embedded: 1, deleted: 0, stale: 0 })
    expect(applyRefresh(second, prepared)).toEqual({ embedded: 0, deleted: 0, stale: 1 })

    expect(storedRows(first)).toHaveLength(1)
    expect(storedRows(second)).toHaveLength(1)
  } finally {
    first.close()
    second.close()
    rmSync(directory, { recursive: true })
  }
})

test('stale deletes and upserts lose when another handle changes only the instruction version', () => {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-stale-refresh-test-'))
  const path = join(directory, 'retrieval.db')
  const first = new Database(path, { create: true })
  const second = new Database(path, { create: true })
  const docChunk = (id: string, text: string): Chunk => ({
    id,
    path: 'doc:project/p/doc',
    identity: { kind: 'doc', scope: 'project', subject: 'p', slug: 'doc' },
    startLine: 1,
    endLine: 1,
    text,
    docTitle: 'Doc',
    headingPath: [],
  })
  const prepare = (plan: ReturnType<typeof planRefresh>): Parameters<typeof applyRefresh>[1] => ({
    corpusKey: 'docs',
    delete: plan.delete,
    upsert: plan.embed.map((candidate) => ({
      ...candidate,
      document: candidate.chunk.text,
      vector,
    })),
  })
  try {
    configureIndexDatabase(first)
    configureIndexDatabase(second)
    const seedPlan = planRefresh(
      [
        { chunk: docChunk('changed', 'seed'), contentHash: 'seed-hash' },
        { chunk: docChunk('removed', 'seed removed'), contentHash: 'removed-hash' },
      ],
      [],
    )
    applyRefresh(first, prepare(seedPlan))

    first.exec("UPDATE document_vector SET instruction_version = 'old-contract'")
    const oldContractSnapshot = storedRows(first)
    const older = planRefresh(
      [{ chunk: docChunk('changed', 'seed'), contentHash: 'seed-hash' }],
      oldContractSnapshot,
    )
    const newer = planRefresh(
      [
        { chunk: docChunk('changed', 'seed'), contentHash: 'seed-hash' },
        { chunk: docChunk('removed', 'seed removed'), contentHash: 'removed-hash' },
      ],
      oldContractSnapshot,
    )

    expect(applyRefresh(second, prepare(newer))).toEqual({ embedded: 2, deleted: 0, stale: 0 })
    expect(applyRefresh(first, prepare(older))).toEqual({ embedded: 0, deleted: 0, stale: 2 })
    expect(
      indexedRows(first).map(({ chunkId, text, contentHash, instructionVersion }) => ({
        chunkId,
        text,
        contentHash,
        instructionVersion,
      })),
    ).toEqual([
      {
        chunkId: 'changed',
        text: 'seed',
        contentHash: 'seed-hash',
        instructionVersion: INSTRUCTION_VERSION,
      },
      {
        chunkId: 'removed',
        text: 'seed removed',
        contentHash: 'removed-hash',
        instructionVersion: INSTRUCTION_VERSION,
      },
    ])
  } finally {
    first.close()
    second.close()
    rmSync(directory, { recursive: true })
  }
})

test('refreshes isolate docs and each project code corpus', () => {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-corpus-isolation-test-'))
  const database = new Database(join(directory, 'retrieval.db'), { create: true })
  const codeChunk = (project: string): Chunk => ({
    id: `code:${project}:src/answer.ts:1-1`,
    path: 'src/answer.ts',
    identity: { kind: 'code', path: 'src/answer.ts' },
    startLine: 1,
    endLine: 1,
    text: project,
  })
  const docChunk: Chunk = {
    id: 'doc:project/p/doc:section-1-1',
    path: 'doc:project/p/doc',
    identity: { kind: 'doc', scope: 'project', subject: 'p', slug: 'doc' },
    startLine: 1,
    endLine: 1,
    text: 'doc',
    docTitle: 'Doc',
    headingPath: [],
  }
  const seed = (corpusKey: string, chunk: Chunk, project?: string) =>
    applyRefresh(database, {
      corpusKey,
      project,
      delete: [],
      upsert: [
        {
          chunk,
          contentHash: `${corpusKey}-hash`,
          observed: null,
          document: chunk.text,
          vector,
        },
      ],
    })
  try {
    configureIndexDatabase(database)
    seed('docs', docChunk)
    seed('code:one', codeChunk('one'), 'one')
    seed('code:two', codeChunk('two'), 'two')

    applyRefresh(database, {
      corpusKey: 'docs',
      delete: planRefresh([], storedRows(database, 'docs')).delete,
      upsert: [],
    })
    expect(storedRows(database, 'docs')).toHaveLength(0)
    expect(storedRows(database, 'code:one')).toHaveLength(1)
    expect(storedRows(database, 'code:two')).toHaveLength(1)

    applyRefresh(database, {
      corpusKey: 'code:one',
      project: 'one',
      delete: planRefresh([], storedRows(database, 'code:one')).delete,
      upsert: [],
    })
    expect(storedRows(database, 'code:one')).toHaveLength(0)
    expect(storedRows(database, 'code:two')).toHaveLength(1)
  } finally {
    database.close()
    rmSync(directory, { recursive: true })
  }
})

test('document refreshes leave code cache rows intact and code refresh prunes expired rows', () => {
  const directory = mkdtempSync(join(tmpdir(), 'retrieval-cache-isolation-test-'))
  const database = new Database(join(directory, 'retrieval.db'), { create: true })
  try {
    configureIndexDatabase(database)
    applyCodeCacheRefresh(database, {
      seenContentHashes: ['old'],
      embedded: [{ contentHash: 'old', document: 'old', vector }],
      now: 1,
    })
    applyRefresh(database, { corpusKey: 'docs', delete: [], upsert: [] })
    expect(planCodeCache(database, ['old'], 1).hits).toHaveLength(1)

    const refreshed = applyCodeCacheRefresh(database, {
      seenContentHashes: ['current'],
      embedded: [{ contentHash: 'current', document: 'current', vector }],
      now: 101,
      retentionMs: 50,
    })
    expect(refreshed).toEqual({ embedded: 1, pruned: 1 })
    expect(planCodeCache(database, ['old'], 101).hits).toHaveLength(0)
    expect(planCodeCache(database, ['current'], 101).hits).toHaveLength(1)
  } finally {
    database.close()
    rmSync(directory, { recursive: true })
  }
})
