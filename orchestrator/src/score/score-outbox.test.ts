import type { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { OUTBOX_PAYLOAD_CONTRACTS } from '../record/outbox-payload-contracts.ts'
import { sanitizeOutboxPayload } from '../record/outbox-sanitize.ts'
import {
  backfillScoreRecords,
  buildScoreRecordPayload,
  enqueueScoreRecord,
  reviewGradesForVerdict,
} from './score-outbox.ts'

const SCORE_RECORD_PAYLOAD_COLUMNS = OUTBOX_PAYLOAD_CONTRACTS.score.columns

const RECORD_ID = '01990000-0000-7000-8000-000000000042'
const MACHINE_ID = '01990000-0000-7000-8000-000000000099'
const STAMP = '2026-09-16T01:00:00.000Z'

function scoredRun(recordId: string | null = RECORD_ID): Database {
  const database = migratedTestDatabase()
  database
    .query(
      `INSERT INTO run
       (number,record_id,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status)
       VALUES (42,?,'2026-09-16T00:00:00.000Z','codex','implement','sha',3,'ask','ok')`,
    )
    .run(recordId)
  database
    .query(
      `INSERT INTO score
       (record_id, run_record_id,delivery,quality,fidelity,note,scored_at,scored_by)
       VALUES ('${newRecordId()}', ?,'full','right','faithful','first',?,'architect')`,
    )
    .run(recordId, STAMP)
  return database
}

const STORED_GRADES = {
  reproduced: 'all' as const,
  coverage: 'adequate' as const,
  limits: 'named' as const,
  overlap: 'alone' as const,
}

test('delivery none omits stored review grades', () => {
  expect(reviewGradesForVerdict('none', STORED_GRADES)).toEqual({
    reproduced: null,
    coverage: null,
    limits: null,
    overlap: null,
  })
})

test.each(['partial', 'full'] as const)(
  'delivery %s preserves stored review grades',
  (delivery) => {
    expect(reviewGradesForVerdict(delivery, STORED_GRADES)).toEqual(STORED_GRADES)
  },
)

test('a verdict without a lens remains without review grades', () => {
  const absent = { reproduced: null, coverage: null, limits: null, overlap: null }
  expect(reviewGradesForVerdict('full', absent)).toEqual(absent)
})

test('score payload maps every hosted verdict field', () => {
  const payload = sanitizeOutboxPayload(
    'score',
    buildScoreRecordPayload(
      {
        record_id: RECORD_ID,
        local_id: 42,
        project_name: null,
        project_record_id: null,
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
    ),
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

test('score enqueue participates in its caller transaction', () => {
  const database = scoredRun()
  expect(() =>
    database
      .transaction(() => {
        enqueueScoreRecord(database, RECORD_ID, MACHINE_ID)
        throw new Error('rollback')
      })
      .immediate(),
  ).toThrow('rollback')
  expect(
    database.query<{ count: number }, []>('SELECT count(*) count FROM outbox').get()!.count,
  ).toBe(0)
  database.close()
})

test('score backfill enqueues each hosted score once', () => {
  const database = scoredRun()
  expect(backfillScoreRecords(database, MACHINE_ID)).toBe(1)
  expect(backfillScoreRecords(database, MACHINE_ID)).toBe(0)
  const outbox = database
    .query<{ kind: string; record_id: string; row_id: string; payload: string }, []>(
      'SELECT * FROM outbox',
    )
    .get()!
  expect(outbox.kind).toBe('score')
  expect(outbox.row_id).toBe(RECORD_ID)
  expect(outbox.record_id).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  )
  expect(outbox.record_id).not.toBe(outbox.row_id)
  expect(JSON.parse(outbox.payload)).toMatchObject({ note: 'first', scoredBy: 'architect' })
  database.close()
})

test.each(['quarantined', 'retired'])('a new score does not overwrite a %s row', (state) => {
  const database = scoredRun()
  enqueueScoreRecord(database, RECORD_ID, MACHINE_ID)
  const original = database
    .query<{ id: number; payload: string }, []>('SELECT id,payload FROM outbox')
    .get()!
  database
    .query(
      `UPDATE outbox SET ${state === 'quarantined' ? 'quarantined_at' : 'retired_at'}=? WHERE id=?`,
    )
    .run(STAMP, original.id)
  database.query("UPDATE score SET note='corrected' WHERE run_record_id=?").run(RECORD_ID)

  enqueueScoreRecord(database, RECORD_ID, MACHINE_ID)

  const rows = database
    .query<{ id: number; payload: string }, []>('SELECT id,payload FROM outbox ORDER BY id')
    .all()
  expect(rows).toHaveLength(2)
  expect(rows[0]).toEqual(original)
  expect(JSON.parse(rows[1]!.payload)).toMatchObject({ note: 'corrected' })
  database.close()
})
