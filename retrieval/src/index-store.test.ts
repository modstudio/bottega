import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chunk } from './corpus/chunks.ts'
import { applyRefresh, configureIndexDatabase, indexedRows, storedRows } from './index-store.ts'
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
    const prepared = { delete: [], upsert: [{ ...candidate, document: 'one', vector }] }
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
        instructionVersion: 'doc-search-v1',
      },
      {
        chunkId: 'removed',
        text: 'seed removed',
        contentHash: 'removed-hash',
        instructionVersion: 'doc-search-v1',
      },
    ])
  } finally {
    first.close()
    second.close()
    rmSync(directory, { recursive: true })
  }
})
