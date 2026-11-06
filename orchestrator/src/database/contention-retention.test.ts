import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { insertSlowStatementContention, summarizeContention } from './contention.ts'
import {
  CONTENTION_RAW_WINDOW_MS,
  pruneContentionRows,
  rollupContentionDays,
} from './contention-retention.ts'
import { setContentionRolledThroughDay } from './contention-rollup-state.ts'
import { migratedTestDatabase } from './test-database.fixture.ts'

test('hosted contention prune window matches the local raw window', () => {
  const migration = readFileSync(
    join(
      import.meta.dir,
      '../../../shared/record/migrations/20261106042841_dev_2133_contention_prune/migration.sql',
    ),
    'utf8',
  )
  const days = migration.match(/retention CONSTANT interval := interval '(\d+) days?'/)?.[1]
  expect(days).toBeDefined()
  expect(Number(days) * 24 * 60 * 60_000).toBe(CONTENTION_RAW_WINDOW_MS)
})

function addContention(
  database: ReturnType<typeof migratedTestDatabase>,
  at: string,
  key: string,
  event: 'wait' | 'invalidation',
  duration: number | null,
  session: string | null = 'session-a',
  occurrences = 1,
): string {
  const recordId = newRecordId()
  database
    .query(
      `INSERT INTO contention
       (record_id,at,session_id,resource_kind,resource_key,event_kind,duration_ms,occurrences)
       VALUES (?,?,?,?,?,?,?,?)`,
    )
    .run(recordId, at, session, 'cpu', key, event, duration, occurrences)
  return recordId
}

function addOutbox(
  database: ReturnType<typeof migratedTestDatabase>,
  rowId: string,
  state: 'pending' | 'quarantined' | 'synced',
): void {
  database
    .query(
      `INSERT INTO outbox
       (kind,row_id,payload,created_at,synced_at,quarantined_at,record_id)
       VALUES ('contention',?,'{}','2026-10-01T00:00:00.000Z',?,?,?)`,
    )
    .run(
      rowId,
      state === 'synced' ? '2026-10-01T00:01:00.000Z' : null,
      state === 'quarantined' ? '2026-10-01T00:02:00.000Z' : null,
      newRecordId(),
    )
}

test('contention rollup is idempotent and preserves summaries across rolled and raw days', () => {
  const database = migratedTestDatabase()
  try {
    addContention(database, '2026-10-01T01:00:00.000Z', 'alpha', 'wait', 30, 'session-a', 3)
    addContention(database, '2026-10-01T02:00:00.000Z', 'alpha', 'wait', -5)
    addContention(database, '2026-10-01T03:00:00.000Z', 'beta', 'invalidation', null, null)
    addContention(database, '2026-10-02T04:00:00.000Z', 'gamma', 'wait', 30, 'session-b')
    const before = summarizeContention(database, '2026-10-01T00:00:00.000Z')

    expect(rollupContentionDays(database, { now: Date.parse('2026-10-02T12:00:00.000Z') })).toEqual(
      {
        days: 1,
        more: false,
      },
    )
    expect(summarizeContention(database, '2026-10-01T00:00:00.000Z')).toEqual(before)

    setContentionRolledThroughDay(database, null)
    expect(rollupContentionDays(database, { now: Date.parse('2026-10-02T12:00:00.000Z') })).toEqual(
      {
        days: 1,
        more: false,
      },
    )
    expect(database.query('SELECT COUNT(*) count FROM contention_day').get()).toEqual({ count: 2 })
    expect(summarizeContention(database, '2026-10-01T00:00:00.000Z')).toEqual(before)
  } finally {
    database.close()
  }
})

test('contention summaries and rollups weight bucket occurrences rather than rows', () => {
  const database = migratedTestDatabase()
  try {
    addContention(database, '2026-10-01T01:00:00.000Z', 'bucket', 'wait', 40, 'session-a', 4)
    const before = summarizeContention(database, '2026-10-01T00:00:00.000Z')
    expect(before.resources.find((row) => row.kind === 'cpu')).toMatchObject({
      count: 4,
      totalDurationMs: 40,
      meanDurationMs: 10,
      topKeys: [{ key: 'bucket', count: 4 }],
    })
    rollupContentionDays(database, { now: Date.parse('2026-10-02T12:00:00.000Z') })
    expect(summarizeContention(database, '2026-10-01T00:00:00.000Z')).toEqual(before)
  } finally {
    database.close()
  }
})

test('contention prune dry run uses the watermark the preceding rollup would establish', () => {
  const database = migratedTestDatabase()
  try {
    addContention(database, '2026-10-01T01:00:00.000Z', 'eligible', 'wait', 1)
    const now = Date.parse('2026-10-20T12:00:00.000Z')
    expect(pruneContentionRows(database, { now, dryRun: true })).toEqual({ rows: 1, more: true })
    rollupContentionDays(database, { now })
    expect(pruneContentionRows(database, { now })).toEqual({ rows: 1, more: false })
  } finally {
    database.close()
  }
})

test('contention prune keeps pending, quarantined, and unrolled raw rows', () => {
  const database = migratedTestDatabase()
  try {
    const pending = addContention(database, '2026-10-01T01:00:00.000Z', 'pending', 'wait', 1)
    const quarantined = addContention(
      database,
      '2026-10-01T02:00:00.000Z',
      'quarantined',
      'wait',
      1,
    )
    const synced = addContention(database, '2026-10-01T03:00:00.000Z', 'synced', 'wait', 1)
    const unrolled = addContention(database, '2026-10-02T03:00:00.000Z', 'unrolled', 'wait', 1)
    addOutbox(database, pending, 'pending')
    addOutbox(database, quarantined, 'quarantined')
    addOutbox(database, synced, 'synced')
    rollupContentionDays(database, { now: Date.parse('2026-10-02T12:00:00.000Z') })

    expect(pruneContentionRows(database, { now: Date.parse('2026-10-20T12:00:00.000Z') })).toEqual({
      rows: 1,
      more: false,
    })
    expect(
      database.query('SELECT resource_key FROM contention ORDER BY resource_key').all(),
    ).toEqual([
      { resource_key: 'pending' },
      { resource_key: 'quarantined' },
      { resource_key: 'unrolled' },
    ])
    expect(
      database.query('SELECT record_id FROM contention WHERE record_id=?').get(unrolled),
    ).not.toBeNull()
  } finally {
    database.close()
  }
})

test('contention prune keeps a closed slow-statement bucket until it has an outbox row', () => {
  const database = migratedTestDatabase()
  try {
    const bucket = addContention(database, '2026-10-01T01:00:00.000Z', 'slow bucket', 'wait', 10)
    database
      .query("UPDATE contention SET resource_kind='store',cause='slow-statement' WHERE record_id=?")
      .run(bucket)
    setContentionRolledThroughDay(database, '2026-10-01')
    expect(
      pruneContentionRows(database, {
        now: Date.parse('2026-10-20T12:00:00.000Z'),
        dryRun: true,
      }),
    ).toEqual({ rows: 0, more: false })
    expect(
      database.query('SELECT record_id FROM contention WHERE record_id=?').get(bucket),
    ).toBeDefined()

    expect(pruneContentionRows(database, { now: Date.parse('2026-10-20T12:00:00.000Z') })).toEqual({
      rows: 0,
      more: false,
    })
    expect(
      database
        .query("SELECT COUNT(*) count FROM outbox WHERE kind='contention' AND row_id=?")
        .get(bucket),
    ).toEqual({ count: 0 })
    expect(
      database.query('SELECT record_id FROM contention WHERE record_id=?').get(bucket),
    ).toBeDefined()
  } finally {
    database.close()
  }
})

test('contention prune removes a delivered slow-statement bucket past the raw window', () => {
  const database = migratedTestDatabase()
  try {
    const bucket = addContention(
      database,
      '2026-10-01T01:00:00.000Z',
      'delivered slow bucket',
      'wait',
      10,
    )
    database
      .query("UPDATE contention SET resource_kind='store',cause='slow-statement' WHERE record_id=?")
      .run(bucket)
    addOutbox(database, bucket, 'synced')
    setContentionRolledThroughDay(database, '2026-10-01')

    expect(pruneContentionRows(database, { now: Date.parse('2026-10-20T12:00:00.000Z') })).toEqual({
      rows: 1,
      more: false,
    })
    expect(
      database.query('SELECT record_id FROM contention WHERE record_id=?').get(bucket),
    ).toBeNull()
  } finally {
    database.close()
  }
})

test('contention retention enqueues a quiet machine closed bucket exactly once', () => {
  const database = migratedTestDatabase()
  try {
    const bucket = addContention(
      database,
      '2026-10-01T01:00:00.000Z',
      'quiet slow bucket',
      'wait',
      10,
    )
    database
      .query("UPDATE contention SET resource_kind='store',cause='slow-statement' WHERE record_id=?")
      .run(bucket)
    const options = { now: Date.parse('2026-10-02T12:00:00.000Z') }
    rollupContentionDays(database, options)
    rollupContentionDays(database, options)
    expect(
      database
        .query("SELECT COUNT(*) count FROM outbox WHERE kind='contention' AND row_id=?")
        .get(bucket),
    ).toEqual({ count: 1 })
  } finally {
    database.close()
  }
})

test('contention retention enqueues an older closed bucket skipped by the hot path', () => {
  const database = migratedTestDatabase()
  try {
    const olderBucket = addContention(
      database,
      '2026-10-23T06:00:00.000Z',
      'older slow bucket',
      'wait',
      10,
    )
    database
      .query("UPDATE contention SET resource_kind='store',cause='slow-statement' WHERE record_id=?")
      .run(olderBucket)

    const now = Date.parse('2026-10-23T08:15:00.000Z')
    insertSlowStatementContention(database, 'current slow bucket', 12, now, 'session-a')
    expect(
      database
        .query("SELECT COUNT(*) count FROM outbox WHERE kind='contention' AND row_id=?")
        .get(olderBucket),
    ).toEqual({ count: 0 })

    rollupContentionDays(database, { now })
    expect(
      database
        .query("SELECT COUNT(*) count FROM outbox WHERE kind='contention' AND row_id=?")
        .get(olderBucket),
    ).toEqual({ count: 1 })
  } finally {
    database.close()
  }
})
