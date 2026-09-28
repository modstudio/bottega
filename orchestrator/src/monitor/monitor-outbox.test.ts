import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import { quarantineOutboxRow } from '../record/outbox-quarantine.ts'
import { outboxQuarantineConditions, outboxRetiredParentConditions } from './monitor-outbox.ts'

test('a quarantined outbox row is a clearing monitor condition', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(
      `INSERT INTO outbox (id,kind,record_id,payload,created_at)
       VALUES (9,'score','record-9','{}','2026-09-28T00:00:00.000Z')`,
    )
    .run()
  quarantineOutboxRow(database, 9, '{}', 'verdict refused', '2026-09-28T00:01:00.000Z')
  expect(outboxQuarantineConditions(database)).toEqual([
    expect.objectContaining({
      kind: 'outbox-quarantined',
      subject: 'outbox:9',
      detail: expect.stringContaining('verdict refused'),
    }),
  ])
  database.close()
})

test('an active outbox row blocked by a retired parent is a clearing monitor condition', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(
      `INSERT INTO outbox
       (id,kind,record_id,payload,created_at,retired_at,retirement_reason)
       VALUES (8,'run','parent','{}','2026-09-28','2026-09-28','not deliverable'),
              (9,'run','child','{"retryOf":"parent"}','2026-09-28',NULL,NULL)`,
    )
    .run()
  expect(outboxRetiredParentConditions(database)).toEqual([
    expect.objectContaining({
      kind: 'outbox-retired-parent',
      subject: 'outbox:9',
      detail: expect.stringContaining('retired parent parent'),
    }),
  ])
  database.close()
})
