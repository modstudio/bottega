import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { applyMigrations } from '../database/migrations.ts'
import {
  backfillScoreRecords,
  buildScoreRecordPayload,
  enqueueScoreRecord,
  SCORE_RECORD_PAYLOAD_COLUMNS,
} from './score-outbox.ts'

const RECORD_ID = '01990000-0000-7000-8000-000000000042'
const MACHINE_ID = '01990000-0000-7000-8000-000000000099'
const STAMP = '2026-09-16T01:00:00.000Z'

function scoredRun(recordId: string | null = RECORD_ID): Database {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(
      `INSERT INTO run
       (id,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,?,'2026-09-16T00:00:00.000Z','codex','implement','sha',3,'ask','ok')`,
    )
    .run(recordId)
  database
    .query(
      `INSERT INTO score
       (run_id,delivery,quality,fidelity,note,scored_at,scored_by)
       VALUES (42,'full','right','faithful','first',?,'architect')`,
    )
    .run(STAMP)
  return database
}

test('score payload maps every hosted verdict field', () => {
  const payload = buildScoreRecordPayload(
    {
      record_id: RECORD_ID,
      local_id: 42,
      project_name: null,
      delivery: 'full',
      quality: 'right',
      fidelity: 'faithful',
      note: 'complete',
      scored_at: STAMP,
      scored_by: 'architect',
      reproduced: null,
      coverage: null,
      limits: null,
      overlap: null,
    },
    MACHINE_ID,
  )
  expect(Object.keys(payload).sort()).toEqual([...SCORE_RECORD_PAYLOAD_COLUMNS].sort())
  expect(payload).toMatchObject({
    id: RECORD_ID,
    machineId: MACHINE_ID,
    localId: 42,
    scoredAt: STAMP,
    updatedAt: STAMP,
    reproduced: null,
    coverage: null,
    limits: null,
    overlap: null,
  })
})

test('score enqueue participates in its caller transaction and skips runs without record ids', () => {
  const database = scoredRun()
  expect(() =>
    database
      .transaction(() => {
        enqueueScoreRecord(database, 42, MACHINE_ID)
        throw new Error('rollback')
      })
      .immediate(),
  ).toThrow('rollback')
  expect(
    database.query<{ count: number }, []>('SELECT count(*) count FROM outbox').get()!.count,
  ).toBe(0)
  database.close()

  const localOnly = scoredRun(null)
  expect(enqueueScoreRecord(localOnly, 42, MACHINE_ID)).toBe(false)
  expect(
    localOnly.query<{ count: number }, []>('SELECT count(*) count FROM outbox').get()!.count,
  ).toBe(0)
  localOnly.close()
})

test('score backfill enqueues a missing hosted score and leaves it alone after sync', () => {
  const database = scoredRun()
  expect(backfillScoreRecords(database, MACHINE_ID)).toBe(1)
  database.query("UPDATE outbox SET synced_at='2026-09-16T02:00:00.000Z'").run()
  expect(backfillScoreRecords(database, MACHINE_ID)).toBe(0)
  const outbox = database
    .query<{ kind: string; record_id: string; payload: string }, []>('SELECT * FROM outbox')
    .get()!
  expect(outbox.kind).toBe('score')
  expect(outbox.record_id).toBe(RECORD_ID)
  expect(JSON.parse(outbox.payload)).toMatchObject({ note: 'first', scoredBy: 'architect' })
  database.close()
})

test('score backfill rebuilds a legacy pending payload with review grades without changing a synced row', () => {
  const database = scoredRun()
  database
    .query("INSERT INTO review (id, recorded_at) VALUES (7, '2026-09-16T00:30:00.000Z')")
    .run()
  database
    .query(
      `INSERT INTO review_lens
       (review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify,
        reproduced,coverage,limits,overlap)
       VALUES (7,42,'correctness','codex','[]','[]','[]','[]','all','adequate','named','alone')`,
    )
    .run()
  const legacyPayload = JSON.stringify({
    id: RECORD_ID,
    spaceId: '01990000-0000-7000-8000-000000000001',
    machineId: MACHINE_ID,
    localId: 42,
    delivery: 'full',
    quality: 'right',
    fidelity: 'faithful',
    note: 'first',
    scoredAt: STAMP,
    scoredBy: 'architect',
    updatedAt: STAMP,
  })
  expect(Object.keys(JSON.parse(legacyPayload))).toHaveLength(11)
  database
    .query(
      `INSERT INTO outbox (kind,record_id,payload,created_at)
       VALUES ('score',?,?,?)`,
    )
    .run(RECORD_ID, legacyPayload, STAMP)
  database
    .query(
      `INSERT INTO outbox (kind,record_id,payload,created_at,synced_at)
       VALUES ('score',?,?,?,'2026-09-16T02:00:00.000Z')`,
    )
    .run(RECORD_ID, legacyPayload, STAMP)

  expect(backfillScoreRecords(database, MACHINE_ID)).toBe(1)
  const rows = database
    .query<{ payload: string; synced_at: string | null }, []>(
      'SELECT payload,synced_at FROM outbox ORDER BY id',
    )
    .all()
  expect(JSON.parse(rows[0]!.payload)).toMatchObject({
    projectName: null,
    reproduced: 'all',
    coverage: 'adequate',
    limits: 'named',
    overlap: 'alone',
  })
  expect(Object.keys(JSON.parse(rows[0]!.payload)).sort()).toEqual(
    [...SCORE_RECORD_PAYLOAD_COLUMNS].sort(),
  )
  expect(rows[1]!.payload).toBe(legacyPayload)
  database.close()
})
