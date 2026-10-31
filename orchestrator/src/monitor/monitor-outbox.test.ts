import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { HostedApiUpgradeRequiredError } from '../record/outbox-held-contract.ts'
import { quarantineOutboxRow } from '../record/outbox-quarantine.ts'
import {
  outboxConditions,
  outboxQuarantineConditions,
  outboxQuarantinedParentConditions,
  outboxRetiredParentConditions,
  QUARANTINE_ERROR_SUMMARY_CHARS,
  quarantineErrorSummary,
} from './monitor-outbox.ts'

test('summarizes a multi-link outbox error with its deepest cause', () => {
  const deepestCause =
    '[42501] new row violates row-level security policy (USING expression) for table "run"'
  const error = `Failed query: INSERT INTO run (${Array.from({ length: 80 }, (_, index) => `column_${index}`).join(', ')})\nparams: ${'private-value,'.repeat(80)}\ncaused by: intermediate adapter error\ncaused by: ${deepestCause}`

  expect(quarantineErrorSummary(error)).toBe(deepestCause)
})

test('leaves a short plain outbox error unchanged', () => {
  const error = "delivery 'none' takes no review grades; remove the review grade fields"

  expect(quarantineErrorSummary(error)).toBe(error)
})

test('bounds the first line of a multi-line plain outbox error', () => {
  const firstLine = 'x'.repeat(QUARANTINE_ERROR_SUMMARY_CHARS + 20)

  expect(quarantineErrorSummary(`${firstLine}\nparams: private-value`)).toBe(
    `${'x'.repeat(QUARANTINE_ERROR_SUMMARY_CHARS - 1)}…`,
  )
})

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

test('a quarantined outbox condition excludes the stored SQL head', () => {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at) VALUES (?,9,'run','record-9','{}','2026-09-28T00:00:00.000Z')`,
    )
    .run(newRecordId())
  quarantineOutboxRow(
    database,
    9,
    '{}',
    'Failed query: INSERT INTO run (payload) VALUES (?)\nparams: private-value\ncaused by: [42501] new row violates row-level security policy (USING expression) for table "run"',
    '2026-09-28T00:01:00.000Z',
  )

  const [condition] = outboxQuarantineConditions(database)
  expect(condition?.detail).toBe(
    'run outbox row 9 is quarantined: [42501] new row violates row-level security policy (USING expression) for table "run"',
  )
  expect(condition?.detail).not.toContain('Failed query')
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
  const conditions = outboxConditions(database, new Date('2026-10-21T00:10:00.000Z').getTime())
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

test('a quarantined parent holding pending rows is a clearing monitor condition', () => {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO outbox (record_id,id,kind,row_id,payload,created_at,quarantined_at) VALUES (?,8,'run','parent','{}','2026-09-28','2026-09-28T01:02:03.000Z'),
              ('01990000-0000-7000-8000-000000000009',9,'score','score-1','{"id":"parent"}','2026-09-28',NULL),
              ('01990000-0000-7000-8000-000000000010',10,'score','score-2','{"id":"parent"}','2026-09-28',NULL)`,
    )
    .run(newRecordId())
  expect(outboxQuarantinedParentConditions(database)).toEqual([
    {
      kind: 'outbox-quarantined-parent',
      subject: 'outbox:8',
      since: '2026-09-28T01:02:03.000Z',
      ageMs: null,
      detail:
        'run outbox row 8 was quarantined at 2026-09-28T01:02:03.000Z; 2 pending rows wait on it',
      action: `retry it with ${PLATFORM_SLUG} record outbox retry orch:8, or retire it with ${PLATFORM_SLUG} record outbox retire orch:8 --reason <text>`,
      ownerSession: null,
    },
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
