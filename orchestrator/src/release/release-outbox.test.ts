import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../record/outbox-payload-contracts.ts'
import { WITHHELD_SECRET_SHAPED } from '../record/outbox-sanitize.ts'
import { finishReleaseLedgerEntry, startReleaseLedgerEntry } from './release-ledger.ts'
import { backfillReleaseRecords, enqueueReleaseRecord } from './release-outbox.ts'

const RELEASE_RECORD_PAYLOAD_CONTRACT = OUTBOX_PAYLOAD_CONTRACTS.release
const DECOY_PROJECT_RECORD_ID = '01990000-0000-7000-8000-000000001213'
const RELEASE_PROJECT_RECORD_ID = '01990000-0000-7000-8000-000000001214'

function fixture(): Database {
  const database = migratedTestDatabase()
  database
    .query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(DECOY_PROJECT_RECORD_ID, 'decoy', '/decoy', '{}')
  database
    .query('INSERT INTO project (record_id,name,path,settings) VALUES (?,?,?,?)')
    .run(RELEASE_PROJECT_RECORD_ID, PLATFORM_SLUG, '/fixture', '{}')
  return database
}

function started(database: Database): number {
  return startReleaseLedgerEntry(database, {
    project: PLATFORM_SLUG,
    rung: 'production',
    candidate: 'candidate-sha',
    live: 'before-sha',
    rollback: false,
    reason: null,
    trunk: 'main',
    trunkTip: 'candidate-sha',
    commitsBehindTrunk: 0,
    behindTrunkReason: null,
  })
}

test('release writes and evolves one whole-row pending payload without deploy output', () => {
  const database = fixture()
  const id = started(database)
  const initial = database
    .query<{ record_id: string; payload: string }, []>(
      `SELECT release_ledger.record_id,outbox.payload FROM release_ledger
       JOIN outbox ON outbox.row_id=release_ledger.record_id`,
    )
    .get()!
  const startedPayload = JSON.parse(initial.payload) as Record<string, unknown>
  expect(Object.keys(startedPayload).sort()).toEqual(
    [...RELEASE_RECORD_PAYLOAD_CONTRACT.columns].sort(),
  )
  expect(initial.record_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  )
  expect(startedPayload).toMatchObject({
    id: initial.record_id,
    projectId: RELEASE_PROJECT_RECORD_ID,
    projectName: PLATFORM_SLUG,
    rung: 'production',
    candidateCommit: 'candidate-sha',
    trunk: 'main',
    trunkTip: 'candidate-sha',
    commitsBehindTrunk: 0,
    liveCommitBefore: 'before-sha',
    finishedAt: null,
    exitCode: null,
    withheldFields: [],
  })
  expect(startedPayload).not.toHaveProperty('outputTail')
  expect(startedPayload).not.toHaveProperty('output_tail')
  expect(database.query('SELECT project_record_id FROM release_ledger WHERE id=?').get(id)).toEqual(
    {
      project_record_id: RELEASE_PROJECT_RECORD_ID,
    },
  )

  finishReleaseLedgerEntry(
    database,
    id,
    { exitCode: 0, output: 'deploy secret' },
    'local output',
    'candidate-sha',
    true,
    null,
  )
  const rows = database
    .query<{ record_id: string; payload: string }, []>(
      "SELECT row_id AS record_id,payload FROM outbox WHERE kind='release' ORDER BY id",
    )
    .all()
  expect(rows).toHaveLength(1)
  expect(rows[0]!.record_id).toBe(initial.record_id)
  expect(JSON.parse(rows[0]!.payload)).toMatchObject({
    id: initial.record_id,
    exitCode: 0,
    liveCommitAfter: 'candidate-sha',
    liveMatchesCandidate: true,
  })
  expect(rows[0]!.payload).not.toContain('local output')
  database.close()
})

test('finishing after the started payload was sent appends the same record identity', () => {
  const database = fixture()
  const id = started(database)
  const first = database
    .query<{ record_id: string }, []>('SELECT row_id AS record_id FROM outbox')
    .get()!
  database.query("UPDATE outbox SET synced_at='2026-10-12T00:00:00.000Z'").run()

  finishReleaseLedgerEntry(
    database,
    id,
    { exitCode: 1, output: '' },
    'failed',
    null,
    null,
    'warning',
  )

  expect(database.query("SELECT count(*) count FROM outbox WHERE kind='release'").get()).toEqual({
    count: 2,
  })
  expect(
    database.query<{ record_id: string }, []>('SELECT row_id AS record_id FROM outbox').all(),
  ).toEqual([{ record_id: first.record_id }, { record_id: first.record_id }])
  database.close()
})

test('release ledger and outbox mutations roll back together', () => {
  const startDatabase = fixture()
  startDatabase.exec(`CREATE TRIGGER fail_release_enqueue BEFORE INSERT ON outbox
    WHEN NEW.kind='release' BEGIN SELECT RAISE(ABORT, 'enqueue failed'); END`)
  expect(() => started(startDatabase)).toThrow('enqueue failed')
  expect(startDatabase.query('SELECT id FROM release_ledger').all()).toEqual([])
  expect(startDatabase.query("SELECT id FROM outbox WHERE kind='release'").all()).toEqual([])

  const finishDatabase = fixture()
  const id = started(finishDatabase)
  finishDatabase.exec(`CREATE TRIGGER fail_release_update BEFORE UPDATE OF payload ON outbox
    WHEN OLD.kind='release' BEGIN SELECT RAISE(ABORT, 'update failed'); END`)
  expect(() =>
    finishReleaseLedgerEntry(
      finishDatabase,
      id,
      { exitCode: 0, output: '' },
      'tail',
      'after',
      true,
      null,
    ),
  ).toThrow('update failed')
  expect(
    finishDatabase
      .query('SELECT finished_at,exit_code,output_tail FROM release_ledger WHERE id=?')
      .get(id),
  ).toEqual({ finished_at: null, exit_code: null, output_tail: '' })
})

test('release sanitizer withholds warning and rollback reason while local values stay intact', () => {
  const database = fixture()
  const secret = 'Authorization: Bearer top-secret-value'
  const id = database
    .query<{ id: number }, [string, string, string]>(
      `INSERT INTO release_ledger
       (record_id,project,rung,candidate_commit,rollback,rollback_reason,actor,started_at,warning)
       VALUES ('01990000-0000-7000-8000-000000000077',?,'production','sha',1,?,'operator','2026-10-12T00:00:00.000Z',?)
       RETURNING id`,
    )
    .get(PLATFORM_SLUG, secret, secret)!.id
  enqueueReleaseRecord(database, id)
  const payload = JSON.parse(
    database.query<{ payload: string }, []>('SELECT payload FROM outbox').get()!.payload,
  ) as Record<string, unknown>
  expect(payload.rollbackReason).toBe(WITHHELD_SECRET_SHAPED)
  expect(payload.warning).toBe(WITHHELD_SECRET_SHAPED)
  expect(payload.withheldFields).toEqual(['rollback_reason', 'warning'])
  expect(database.query('SELECT rollback_reason,warning FROM release_ledger').get()).toEqual({
    rollback_reason: secret,
    warning: secret,
  })
})

test('release backfill enqueues each existing row once', () => {
  const database = fixture()
  database
    .query(
      `INSERT INTO release_ledger
       (record_id,project,rung,candidate_commit,rollback,actor,started_at)
       VALUES ('01990000-0000-7000-8000-000000000031',?,'production','one',0,'operator','2026-10-12T00:00:00.000Z'),
              ('01990000-0000-7000-8000-000000000032',?,'production','two',0,'operator','2026-10-12T00:01:00.000Z')`,
    )
    .run(PLATFORM_SLUG, PLATFORM_SLUG)
  expect(backfillReleaseRecords(database)).toEqual({ enqueued: 2 })
  expect(backfillReleaseRecords(database)).toEqual({ enqueued: 0 })
  expect(database.query("SELECT count(*) count FROM outbox WHERE kind='release'").get()).toEqual({
    count: 2,
  })
  database.close()
})
