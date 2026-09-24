import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Chunk } from './corpus/chunks.ts'
import { applyRefresh, configureIndexDatabase, storedRows } from './index-store.ts'

const vector = [1, ...Array.from<number>({ length: 1_023 }).fill(0)]

test('two handles interleave cold schema creation and idempotent immediate refreshes', () => {
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
    const candidate = { chunk, contentHash: 'hash' }
    const plan = { embed: [candidate], delete: [], unchanged: [] }
    const embedded = [{ ...candidate, document: 'one', vector }]
    applyRefresh(first, plan, embedded)
    applyRefresh(second, plan, embedded)

    expect(storedRows(first)).toHaveLength(1)
    expect(storedRows(second)).toHaveLength(1)
  } finally {
    first.close()
    second.close()
    rmSync(directory, { recursive: true })
  }
})
