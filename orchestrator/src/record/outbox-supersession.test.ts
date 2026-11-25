import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { options, STAMP } from '../../test/fixtures/record-sync.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { outboxRowWaitsForParent } from './outbox-dependency.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from './outbox-payload-contracts.ts'
import {
  type OtherOutboxRow,
  retireSupersededQuarantinedOutboxRows,
  supersedingOutboxRow,
} from './outbox-supersession.ts'
import { syncRecord } from './record-sync.ts'

const EARLIER = '2026-09-15T00:59:00.000Z'
const LATER = '2026-09-15T01:02:00.000Z'

describe('score outbox supersession decision', () => {
  const quarantined = { id: 7, kind: 'score' as const, rowId: 'run-record-id', scoredAt: STAMP }
  const candidate = (overrides: Partial<OtherOutboxRow> = {}): OtherOutboxRow => ({
    id: 8,
    kind: 'score',
    rowId: quarantined.rowId,
    scoredAt: LATER,
    quarantined: false,
    retired: false,
    ...overrides,
  })

  test('names a later verdict even when retry refreshed a lower-id row in place', () => {
    expect(supersedingOutboxRow(quarantined, [candidate({ id: 6 })])?.id).toBe(6)
  })

  test('does not supersede without a later row', () => {
    expect(supersedingOutboxRow(quarantined, [])).toBeNull()
  })

  test('does not supersede with an earlier verdict despite a higher id', () => {
    expect(supersedingOutboxRow(quarantined, [candidate({ scoredAt: EARLIER })])).toBeNull()
  })

  test('does not supersede with a retired row', () => {
    expect(supersedingOutboxRow(quarantined, [candidate({ retired: true })])).toBeNull()
  })

  test('names the greatest verdict time and breaks ties with the highest id', () => {
    expect(
      supersedingOutboxRow(quarantined, [
        candidate({ id: 12, scoredAt: '2026-09-15T01:01:00.000Z' }),
        candidate({ id: 9 }),
        candidate({ id: 11 }),
        candidate({ id: 10 }),
      ])?.id,
    ).toBe(11)
  })

  test('does not name another quarantined row', () => {
    expect(supersedingOutboxRow(quarantined, [candidate({ quarantined: true })])).toBeNull()
  })

  test('does not name a score row from another run', () => {
    expect(supersedingOutboxRow(quarantined, [candidate({ rowId: 'another-run' })])).toBeNull()
  })

  test('equal verdict time supersedes only with a higher id', () => {
    expect(supersedingOutboxRow(quarantined, [candidate({ id: 8, scoredAt: STAMP })])?.id).toBe(8)
    expect(supersedingOutboxRow(quarantined, [candidate({ id: 6, scoredAt: STAMP })])).toBeNull()
  })
})

describe('non-score outbox supersession decision', () => {
  const quarantined = { id: 7, kind: 'run' as const, rowId: 'run-record-id', scoredAt: null }
  const candidate = (overrides: Partial<OtherOutboxRow> = {}): OtherOutboxRow => ({
    id: 8,
    kind: 'run',
    rowId: quarantined.rowId,
    scoredAt: null,
    quarantined: false,
    retired: false,
    ...overrides,
  })

  test('requires a higher outbox id', () => {
    expect(supersedingOutboxRow(quarantined, [candidate({ id: 6 })])).toBeNull()
  })

  test('does not name another quarantined row', () => {
    expect(supersedingOutboxRow(quarantined, [candidate({ quarantined: true })])).toBeNull()
  })

  test('does not name a retired row', () => {
    expect(supersedingOutboxRow(quarantined, [candidate({ retired: true })])).toBeNull()
  })

  test('does not name another identity', () => {
    expect(supersedingOutboxRow(quarantined, [candidate({ rowId: 'another-run' })])).toBeNull()
  })

  test('does not name another kind', () => {
    expect(supersedingOutboxRow(quarantined, [candidate({ kind: 'review' })])).toBeNull()
  })

  test('chooses the highest id among several later rows', () => {
    expect(
      supersedingOutboxRow(quarantined, [
        candidate({ id: 9 }),
        candidate({ id: 12 }),
        candidate({ id: 10 }),
      ])?.id,
    ).toBe(12)
  })
})

const OUTBOX_KINDS = Object.keys(
  OUTBOX_PAYLOAD_CONTRACTS,
) as (keyof typeof OUTBOX_PAYLOAD_CONTRACTS)[]

function insertOutboxRows(kind: string) {
  const database = migratedTestDatabase()
  const insert = database.query(
    `INSERT INTO outbox
     (record_id,id,kind,row_id,payload,created_at,synced_at,quarantined_at,quarantine_reason,last_error)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
  insert.run(
    newRecordId(),
    7,
    kind,
    'run-record-id',
    JSON.stringify({ scoredAt: STAMP }),
    STAMP,
    null,
    STAMP,
    'verdict refused',
    'verdict refused',
  )
  insert.run(
    newRecordId(),
    8,
    kind,
    'run-record-id',
    JSON.stringify({ scoredAt: LATER }),
    LATER,
    LATER,
    null,
    null,
    null,
  )
  return database
}

test('sync retires and audits a quarantined score superseded by a later score', async () => {
  const database = insertOutboxRows('score')
  const result = await syncRecord(options(database, fakePostgres()))

  expect(result.retired).toBeUndefined()
  expect(result.superseded).toBe(1)
  expect(
    database.query('SELECT retired_at,retirement_reason FROM outbox WHERE id=7').get(),
  ).toEqual({
    retired_at: STAMP,
    retirement_reason: 'superseded by score outbox row 8',
  })
  expect(
    database
      .query(
        `SELECT disposition,reason,actor_session
           FROM outbox_quarantine_audit WHERE outbox_id=7 AND disposition='retire'`,
      )
      .get(),
  ).toEqual({
    disposition: 'retire',
    reason: 'superseded by score outbox row 8',
    actor_session: null,
  })
  database.close()
})

test.each(OUTBOX_KINDS)(
  'sync retires and audits a quarantined %s row superseded by a later row',
  async (kind) => {
    const database = insertOutboxRows(kind)
    const result = await syncRecord(options(database, fakePostgres()))

    expect(result.retired).toBeUndefined()
    expect(result.superseded).toBe(1)
    expect(
      database.query('SELECT retired_at,retirement_reason FROM outbox WHERE id=7').get(),
    ).toEqual({
      retired_at: STAMP,
      retirement_reason: `superseded by ${kind} outbox row 8`,
    })
    expect(
      database
        .query(
          `SELECT disposition,reason,actor_session
             FROM outbox_quarantine_audit WHERE outbox_id=7 AND disposition='retire'`,
        )
        .get(),
    ).toEqual({
      disposition: 'retire',
      reason: `superseded by ${kind} outbox row 8`,
      actor_session: null,
    })
    database.close()
  },
)

test('a superseded parent defers its child on the later live row instead of blocking it', () => {
  const database = migratedTestDatabase()
  const insert = database.query(
    `INSERT INTO outbox
     (record_id,id,kind,row_id,payload,created_at,synced_at,quarantined_at,quarantine_reason,last_error)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
  )
  insert.run(
    newRecordId(),
    7,
    'run',
    'run-record-id',
    '{}',
    STAMP,
    null,
    STAMP,
    'run refused',
    'run refused',
  )
  insert.run(newRecordId(), 8, 'run', 'run-record-id', '{}', LATER, null, null, null, null)
  const scorePayload = JSON.stringify({ id: 'run-record-id' })
  insert.run(
    newRecordId(),
    9,
    'score',
    'score-record-id',
    scorePayload,
    LATER,
    null,
    null,
    null,
    null,
  )

  expect(retireSupersededQuarantinedOutboxRows(database, STAMP)).toBe(1)
  expect(
    outboxRowWaitsForParent(
      database,
      { id: 9, kind: 'score', row_id: 'score-record-id', payload: scorePayload },
      { id: 'run-record-id' },
    ),
  ).toEqual({
    disposition: 'deferred',
    parentDeferred: {
      id: 9,
      kind: 'score',
      cause: 'unsynced-parent',
      reason: 'waits for run run-record-id, whose outbox row orch:8 has not synced',
    },
  })
  database.close()
})

test('sync skips a score row retired between the supersession scan and write', async () => {
  const database = insertOutboxRows('score')
  const originalQuery = database.query.bind(database)
  const mutable = database as unknown as { query: typeof database.query }
  mutable.query = ((sql: string) => {
    const statement = originalQuery(sql)
    if (!sql.includes('WHERE kind=? AND row_id=?')) return statement
    const originalAll = statement.all.bind(statement)
    statement.all = ((kind: string, rowId: string) => {
      const rows = originalAll(kind, rowId)
      originalQuery('UPDATE outbox SET retired_at=?,retirement_reason=? WHERE id=7').run(
        STAMP,
        'disposed concurrently',
      )
      return rows
    }) as typeof statement.all
    return statement
  }) as typeof database.query

  const result = await syncRecord(options(database, fakePostgres()))

  expect(result).toMatchObject({ pushed: 0, failed: 0, pending: 0 })
  expect(result.superseded).toBeUndefined()
  expect(
    database.query('SELECT retired_at,retirement_reason FROM outbox WHERE id=7').get(),
  ).toEqual({
    retired_at: STAMP,
    retirement_reason: 'disposed concurrently',
  })
  database.close()
})
