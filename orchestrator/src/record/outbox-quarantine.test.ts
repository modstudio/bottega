import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { retireOutboxRowWithDependencyProof } from './outbox-operator.ts'
import { quarantineOutboxRow, retireOutboxRow, retryOutboxRow } from './outbox-quarantine.ts'

function fixture(): Database {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(
      `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at) VALUES (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),7,'score','record-7','{}','2026-09-28T00:00:00.000Z')`,
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
        .query<
          {
            disposition: string
            actor_session: string
            attempts: number
            record_id: string
            row_id: string
          },
          []
        >(
          'SELECT disposition,actor_session,attempts,record_id,row_id FROM outbox_quarantine_audit ORDER BY id',
        )
        .all(),
    ).toEqual([
      {
        disposition: 'quarantine',
        actor_session: 'sync-session',
        attempts: 1,
        record_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        row_id: 'record-7',
      },
      {
        disposition: 'retry',
        actor_session: 'operator-session',
        attempts: 1,
        record_id: expect.stringMatching(
          /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
        ),
        row_id: 'record-7',
      },
    ])
    const auditIds = database
      .query<{ record_id: string; row_id: string }, []>(
        'SELECT record_id,row_id FROM outbox_quarantine_audit ORDER BY id',
      )
      .all()
    expect(new Set(auditIds.map((row) => row.record_id)).size).toBe(2)
    expect(auditIds.every((row) => row.record_id !== row.row_id)).toBe(true)
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
    expect(() => retryOutboxRow(7, database)).toThrow(
      'outbox row 7 is retired and permanently not deliverable',
    )
    database.close()
  })

  test('audit rows cannot be changed or deleted', () => {
    const database = fixture()
    expect(() =>
      database.query("UPDATE outbox_quarantine_audit SET reason='changed'").run(),
    ).toThrow('outbox quarantine audit is append-only')
    expect(() => database.query('DELETE FROM outbox_quarantine_audit').run()).toThrow(
      'outbox quarantine audit is append-only',
    )
    database.close()
  })

  test('retry and retire refuse a non-quarantined row', () => {
    const database = fixture()
    retryOutboxRow(7, database)
    expect(() => retryOutboxRow(7, database)).toThrow('outbox row 7 is not quarantined')
    expect(() => retireOutboxRow(7, 'discard', database)).toThrow('outbox row 7 is not quarantined')
    database.close()
  })

  test('retire accepts an active row blocked by a retired parent and audits it', () => {
    const database = new Database(':memory:')
    applyMigrations(database)
    database
      .query(
        `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at,retired_at,retirement_reason) VALUES (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-7' || substr(lower(hex(randomblob(2))),2) || '-' || substr('89ab',abs(random()) % 4 + 1,1) || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6))),8,'run','parent','{}','2026-09-28','2026-09-28','not deliverable'),
                ('01990000-0000-7000-8000-000000000009',9,'run','child','{"parentRunId":"parent"}','2026-09-28',NULL,NULL)`,
      )
      .run()

    retireOutboxRowWithDependencyProof(
      9,
      'parent cannot be delivered',
      database,
      '2026-09-28T00:04:00.000Z',
    )

    expect(
      database.query('SELECT retired_at,retirement_reason FROM outbox WHERE id=9').get(),
    ).toEqual({
      retired_at: '2026-09-28T00:04:00.000Z',
      retirement_reason: 'parent cannot be delivered',
    })
    expect(
      database
        .query(
          `SELECT outbox_id,disposition,error,attempts,reason
           FROM outbox_quarantine_audit WHERE outbox_id=9`,
        )
        .get(),
    ).toEqual({
      outbox_id: 9,
      disposition: 'retire',
      error: null,
      attempts: 0,
      reason: 'parent cannot be delivered',
    })
    database.close()
  })
})
