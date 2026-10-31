import { beforeEach, describe, expect, test } from 'bun:test'
import { resetFixtureStore } from '../../test/run-fixtures.ts'
import { db, writeTransaction } from '../db.ts'
import { categorize, GIT_INGEST_BATCH_SIZE, writeGitIngestBatches } from './git.ts'

beforeEach(resetFixtureStore)

describe('git FileKind compatibility', () => {
  test('the shared classifier preserves the former hub classifications', () => {
    const cases = [
      ['drizzle/meta/snapshot.json', 'generated'],
      ['bun.lock', 'generated'],
      ['src/app.test.ts', 'test'],
      ['tests/example.ts', 'test'],
      ['docs/guide.txt', 'docs'],
      ['README.md', 'docs'],
      ['package.json', 'config'],
      ['src/fixtures/example.ts', 'product'],
      ['src/app.ts', 'product'],
    ] as const
    for (const [path, expected] of cases) expect(categorize(path)).toBe(expected)
  })
})

test('more than one git batch uses multiple transactions and stores the single-pass result', () => {
  const commits = Array.from({ length: GIT_INGEST_BATCH_SIZE + 1 }, (_, index) => ({
    sha: `commit-${index}`,
    repo: 'alpha',
    key: 'ALP-118',
    at: `2026-10-30T12:${String(index).padStart(2, '0')}:00.000Z`,
  }))
  const activity = {
    tasks: new Set(['alpha:ALP-118']),
    commits: commits.length,
    files: new Set(['alpha:src/index.ts']),
    lines: { generated: 0, test: 0, docs: 0, config: 0, product: 12 },
  }
  const scan = { days: new Map([['2026-10-30', activity]]), tasks: new Map(), commits }
  let batchedTransactions = 0
  writeGitIngestBatches(scan, 'machine-one', '2026-10-30T13:00:00.000Z', (fn) => {
    batchedTransactions++
    return writeTransaction(fn)
  })
  const stored = {
    commits: db().query(`SELECT sha,repo,task_key,at FROM commit_key ORDER BY sha`).all(),
    days: db()
      .query(
        `SELECT machine_id,day,tasks,commits,files,lines_product,collected_at FROM day ORDER BY day`,
      )
      .all(),
  }

  resetFixtureStore()
  let singleTransactions = 0
  writeGitIngestBatches(
    scan,
    'machine-one',
    '2026-10-30T13:00:00.000Z',
    (fn) => {
      singleTransactions++
      return writeTransaction(fn)
    },
    Number.POSITIVE_INFINITY,
  )
  const singleStored = {
    commits: db().query(`SELECT sha,repo,task_key,at FROM commit_key ORDER BY sha`).all(),
    days: db()
      .query(
        `SELECT machine_id,day,tasks,commits,files,lines_product,collected_at FROM day ORDER BY day`,
      )
      .all(),
  }

  expect(stored).toEqual(singleStored)
  expect(batchedTransactions).toBe(2)
  expect(singleTransactions).toBe(1)
})
