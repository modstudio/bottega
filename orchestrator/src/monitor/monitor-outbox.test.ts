import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { HostedApiUpgradeRequiredError } from '../record/outbox-held-contract.ts'
import { quarantineOutboxRow } from '../record/outbox-quarantine.ts'
import {
  outboxHeldForUpgradeConditions,
  outboxQuarantineConditions,
  outboxRetiredParentConditions,
} from './monitor-outbox.ts'

test('a quarantined outbox row is a clearing monitor condition', () => {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at) VALUES (?,9,'score','record-9','{}','2026-09-28T00:00:00.000Z')`,
    )
    .run(newRecordId())
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

test('held outbox rows produce one upgrade condition per kind', () => {
  const database = migratedTestDatabase()
  const runReason = new HostedApiUpgradeRequiredError('run', ['futureRun']).message
  const scoreReason = new HostedApiUpgradeRequiredError('score', ['futureScore']).message
  database
    .query(
      `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at,last_error) VALUES
       (?,7,'run','run-7','{}','2026-10-21T00:00:00.000Z',?),
       (?,8,'run','run-8','{}','2026-10-21T00:01:00.000Z',?),
       (?,9,'score','score-9','{}','2026-10-21T00:02:00.000Z',?)`,
    )
    .run(newRecordId(), runReason, newRecordId(), runReason, newRecordId(), scoreReason)
  const conditions = outboxHeldForUpgradeConditions(
    database,
    new Date('2026-10-21T00:10:00.000Z').getTime(),
  )
  expect(conditions).toHaveLength(2)
  expect(conditions).toEqual([
    expect.objectContaining({
      kind: 'outbox-held-for-upgrade',
      subject: 'outbox-kind:run',
      ageMs: 600_000,
      detail: expect.stringContaining('2 run outbox row(s) held; oldest age 10m;'),
    }),
    expect.objectContaining({
      kind: 'outbox-held-for-upgrade',
      subject: 'outbox-kind:score',
      ageMs: 480_000,
      detail: expect.stringContaining('futureScore'),
    }),
  ])
  database.close()
})

test('an active outbox row blocked by a retired parent is a clearing monitor condition', () => {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at,retired_at,retirement_reason) VALUES (?,8,'run','parent','{}','2026-09-28','2026-09-28','not deliverable'),
              ('01990000-0000-7000-8000-000000000009',9,'run','child','{"retryOf":"parent"}','2026-09-28',NULL,NULL)`,
    )
    .run(newRecordId())
  expect(outboxRetiredParentConditions(database)).toEqual([
    expect.objectContaining({
      kind: 'outbox-retired-parent',
      subject: 'outbox:9',
      detail: expect.stringContaining('retired parent parent'),
    }),
  ])
  database.close()
})

test('a synced parent with a later retired snapshot does not raise the condition', () => {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at,synced_at,retired_at,retirement_reason) VALUES (?,7,'run','parent','{}','2026-09-28','2026-09-28',NULL,NULL),
              ('01990000-0000-7000-8000-000000000008',8,'run','parent','{}','2026-09-28',NULL,'2026-09-28','later snapshot'),
              ('01990000-0000-7000-8000-000000000009',9,'run','child','{"parentRunId":"parent"}','2026-09-28',NULL,NULL,NULL)`,
    )
    .run(newRecordId())
  expect(outboxRetiredParentConditions(database)).toEqual([])
  database.close()
})

test('a malformed retired lens payload is an explicit unreadable-parent condition', () => {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at,retired_at,retirement_reason) VALUES (?,8,'review_lens','lens-parent','{','2026-09-28','2026-09-28','bad payload'),
              ('01990000-0000-7000-8000-000000000009',9,'review_finding','finding','{"reviewId":"review","reviewLensId":"lens-parent"}','2026-09-28',NULL,NULL)`,
    )
    .run(newRecordId())
  expect(outboxRetiredParentConditions(database)).toEqual([
    expect.objectContaining({ detail: expect.stringContaining('unreadable stored payload') }),
  ])
  database.close()
})
