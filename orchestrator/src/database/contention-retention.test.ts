import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { summarizeContention } from './contention.ts'
import { pruneContentionRows, rollupContentionDays } from './contention-retention.ts'
import { setContentionRolledThroughDay } from './contention-rollup-state.ts'
import { migratedTestDatabase } from './test-database.fixture.ts'

function addContention(
  database: ReturnType<typeof migratedTestDatabase>,
  at: string,
  key: string,
  event: 'wait' | 'invalidation',
  duration: number | null,
  session: string | null = 'session-a',
): string {
  const recordId = newRecordId()
  database
    .query(
      `INSERT INTO contention
       (record_id,at,session_id,resource_kind,resource_key,event_kind,duration_ms)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(recordId, at, session, 'cpu', key, event, duration)
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
    addContention(database, '2026-10-01T01:00:00.000Z', 'alpha', 'wait', 10)
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
