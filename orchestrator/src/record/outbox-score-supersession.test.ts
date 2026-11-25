import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { options, STAMP } from '../../test/fixtures/record-sync.ts'
import { fakePostgres } from '../../test/fixtures/record-sync-postgres.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { syncRecord } from './record-sync.ts'
import { supersedingScoreOutboxRow } from './outbox-score-supersession.ts'

const EARLIER = '2026-09-15T00:59:00.000Z'
const LATER = '2026-09-15T01:02:00.000Z'

describe('score outbox supersession decision', () => {
  const quarantined = { id: 7, scoredAt: STAMP }

  test('names a later row', () => {
    expect(
      supersedingScoreOutboxRow(quarantined, [{ id: 8, scoredAt: LATER, retired: false }]),
    ).toBe(8)
  })

  test('does not supersede without a later row', () => {
    expect(
      supersedingScoreOutboxRow(quarantined, [{ id: 6, scoredAt: LATER, retired: false }]),
    ).toBeNull()
  })

  test('does not supersede with an earlier score', () => {
    expect(
      supersedingScoreOutboxRow(quarantined, [{ id: 8, scoredAt: EARLIER, retired: false }]),
    ).toBeNull()
  })

  test('does not supersede with a retired row', () => {
    expect(
      supersedingScoreOutboxRow(quarantined, [{ id: 8, scoredAt: LATER, retired: true }]),
    ).toBeNull()
  })

  test('names the highest qualifying id', () => {
    expect(
      supersedingScoreOutboxRow(quarantined, [
        { id: 9, scoredAt: LATER, retired: false },
        { id: 11, scoredAt: LATER, retired: false },
        { id: 10, scoredAt: LATER, retired: false },
      ]),
    ).toBe(11)
  })
})

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

  expect(result.retired).toBe(1)
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

test('sync leaves a quarantined row of another kind visible', async () => {
  const database = insertOutboxRows('run')
  const result = await syncRecord(options(database, fakePostgres()))

  expect(result.retired).toBeUndefined()
  expect(
    database.query('SELECT retired_at,retirement_reason FROM outbox WHERE id=7').get(),
  ).toEqual({ retired_at: null, retirement_reason: null })
  expect(
    database
      .query(
        `SELECT count(*) AS count FROM outbox_quarantine_audit
          WHERE outbox_id=7 AND disposition='retire'`,
      )
      .get(),
  ).toEqual({ count: 0 })
  database.close()
})
