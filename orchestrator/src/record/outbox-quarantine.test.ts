import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { quarantineOutboxRow, retireOutboxRow, retryOutboxRow } from './outbox-quarantine.ts'

function fixture(): Database {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(
      `INSERT INTO outbox (id,kind,record_id,payload,created_at)
       VALUES (7,'score','record-7','{}','2026-09-28T00:00:00.000Z')`,
    )
    .run()
  quarantineOutboxRow(
    database,
    7,
    '{}',
    'verdict refused',
    '2026-09-28T00:01:00.000Z',
    'sync-session',
  )
  return database
}

describe('outbox quarantine exits', () => {
  test('retry clears quarantine and audits the transition', () => {
    const database = fixture()
    retryOutboxRow(7, database, '2026-09-28T00:02:00.000Z', 'operator-session')
    expect(
      database
        .query('SELECT quarantined_at,quarantine_reason,last_error FROM outbox WHERE id=7')
        .get(),
    ).toEqual({ quarantined_at: null, quarantine_reason: null, last_error: null })
    expect(
      database
        .query('SELECT disposition,actor_session,attempts FROM outbox_quarantine_audit ORDER BY id')
        .all(),
    ).toEqual([
      { disposition: 'quarantine', actor_session: 'sync-session', attempts: 1 },
      { disposition: 'retry', actor_session: 'operator-session', attempts: 1 },
    ])
    database.close()
  })

  test('retire preserves quarantine and permanently removes the row from delivery', () => {
    const database = fixture()
    retireOutboxRow(7, 'invalid historical verdict', database, '2026-09-28T00:03:00.000Z')
    expect(
      database.query('SELECT retired_at,retirement_reason FROM outbox WHERE id=7').get(),
    ).toEqual({
      retired_at: '2026-09-28T00:03:00.000Z',
      retirement_reason: 'invalid historical verdict',
    })
    expect(
      database
        .query('SELECT disposition,reason FROM outbox_quarantine_audit ORDER BY id DESC LIMIT 1')
        .get(),
    ).toEqual({ disposition: 'retire', reason: 'invalid historical verdict' })
    database.close()
  })

  test('retry and retire refuse a non-quarantined row', () => {
    const database = fixture()
    retryOutboxRow(7, database)
    expect(() => retryOutboxRow(7, database)).toThrow('outbox row 7 is not quarantined')
    expect(() => retireOutboxRow(7, 'discard', database)).toThrow('outbox row 7 is not quarantined')
    database.close()
  })
})
