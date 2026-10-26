import type { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { HostedApiUpgradeRequiredError } from './outbox-held-contract.ts'
import { retireOutboxRowWithDependencyProof } from './outbox-operator.ts'
import {
  quarantineOutboxRow,
  retireOutboxRow,
  retryOutboxRow,
  retryOutboxRowsMatching,
} from './outbox-quarantine.ts'

function fixture(): Database {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at) VALUES (?,7,'score','record-7','{}','2026-09-28T00:00:00.000Z')`,
    )
    .run(newRecordId())
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

  test('matching retry clears and audits only quarantined rows containing the text', () => {
    const database = fixture()
    database
      .query(
        `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at,quarantined_at,quarantine_reason,last_error)
         VALUES
           (?,8,'run','record-8','{}','2026-09-28T00:00:00.000Z','2026-09-28T00:01:00.000Z','parent is absent','parent is absent'),
           (?,9,'run','record-9','{}','2026-09-28T00:00:00.000Z','2026-09-28T00:01:00.000Z','different refusal','different refusal'),
           (?,10,'run','record-10','{}','2026-09-28T00:00:00.000Z',NULL,'parent is absent','parent is absent')`,
      )
      .run(newRecordId(), newRecordId(), newRecordId())

    expect(
      retryOutboxRowsMatching(
        'parent is absent',
        database,
        '2026-09-28T00:02:00.000Z',
        'operator-session',
      ),
    ).toBe(1)
    expect(
      database
        .query('SELECT id,quarantined_at FROM outbox WHERE id BETWEEN 7 AND 10 ORDER BY id')
        .all(),
    ).toEqual([
      { id: 7, quarantined_at: '2026-09-28T00:01:00.000Z' },
      { id: 8, quarantined_at: null },
      { id: 9, quarantined_at: '2026-09-28T00:01:00.000Z' },
      { id: 10, quarantined_at: null },
    ])
    expect(
      database
        .query(
          `SELECT outbox_id,disposition,actor_session FROM outbox_quarantine_audit
           WHERE disposition='retry' ORDER BY outbox_id`,
        )
        .all(),
    ).toEqual([{ outbox_id: 8, disposition: 'retry', actor_session: 'operator-session' }])
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
    const database = migratedTestDatabase()
    database
      .query(
        `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at,retired_at,retirement_reason) VALUES (?,8,'run','parent','{}','2026-09-28','2026-09-28','not deliverable'),
                ('01990000-0000-7000-8000-000000000009',9,'run','child','{"parentRunId":"parent"}','2026-09-28',NULL,NULL)`,
      )
      .run(newRecordId())

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

  test('retire accepts a held row and audits it', () => {
    const database = migratedTestDatabase()
    const heldReason = new HostedApiUpgradeRequiredError('run', ['futureColumn']).message
    database
      .query(
        `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at,last_error,attempts)
         VALUES (?,10,'run','held-run','{}','2026-09-28',?,1)`,
      )
      .run(newRecordId(), heldReason)

    retireOutboxRowWithDependencyProof(
      10,
      'operator chose not to deliver it',
      database,
      '2026-09-28T00:05:00.000Z',
      'operator-session',
    )

    expect(
      database.query('SELECT retired_at,retirement_reason FROM outbox WHERE id=10').get(),
    ).toEqual({
      retired_at: '2026-09-28T00:05:00.000Z',
      retirement_reason: 'operator chose not to deliver it',
    })
    expect(
      database
        .query(
          `SELECT disposition,error,attempts,reason,actor_session
           FROM outbox_quarantine_audit WHERE outbox_id=10`,
        )
        .get(),
    ).toEqual({
      disposition: 'retire',
      error: heldReason,
      attempts: 1,
      reason: 'operator chose not to deliver it',
      actor_session: 'operator-session',
    })
    database.close()
  })
})
