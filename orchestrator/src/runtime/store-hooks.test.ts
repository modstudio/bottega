import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { closeDatabaseForFixture, db, migrateDatabase } from '../database/db.ts'
import { nextEntityNumber } from '../database/entity-number.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { enqueueReview } from '../review/review-outbox.ts'
import { STANDARD_OPEN_HOOKS } from './store-hooks.ts'

test('standard writable-open hooks leave superseded asking turns for explicit repair paths', () => {
  const root = addRun({ agent: 'codex', job: 'craft', status: 'ok' })
  const asking = addRun({
    agent: 'codex',
    job: 'craft',
    status: 'asking',
    parent: root,
    turn: 2,
  })
  addRun({ agent: 'codex', job: 'craft', status: 'ok', parent: root, turn: 3 })

  for (const hook of STANDARD_OPEN_HOOKS.afterWritableOpen ?? []) hook(db())

  expect(db().query('SELECT status FROM run WHERE record_id=?').get(asking)).toEqual({
    status: 'asking',
  })
})

test('standard after-initialize hooks backfill classifiable rounds and re-enqueue them once', () => {
  const project = newRecordId()
  db()
    .query("INSERT INTO project (record_id,name,path,settings) VALUES (?,'adanim','/adanim','{}')")
    .run(project)
  const addReview = (
    number: number,
    patch: string | null,
    role: 'round' | 'supplementary' = 'round',
    evidenceExcluded = false,
  ) => {
    const review = newRecordId()
    const run = addRun({
      agent: 'codex',
      job: 'review-lens',
      lens: 'correctness',
      startedAt: `2026-10-2${number}T00:00:00Z`,
      repo: 'adanim',
    })
    db()
      .query('UPDATE run SET branch=?,project_record_id=?,evidence_excluded=? WHERE record_id=?')
      .run(
        'worktree-ADN-1004-worktree-teardown',
        project,
        evidenceExcluded ? 'historical exclusion' : null,
        run,
      )
    db()
      .query(
        `INSERT INTO review (record_id,number,recorded_at,patch_id,path_set,role)
         VALUES (?,?,?,?,'["change.ts"]',?)`,
      )
      .run(review, number, `2026-10-2${number}T01:00:00Z`, patch, role)
    db()
      .query(
        `INSERT INTO review_lens
         (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
         VALUES (?,?,?,'correctness','codex','[]','[]','[]','[]')`,
      )
      .run(newRecordId(), review, run)
    enqueueReview(db(), review)
    return review
  }
  const first = addReview(1, 'one')
  const second = addReview(2, 'two')
  const repeated = addReview(3, 'one')
  const supplementary = addReview(4, 'three', 'supplementary')
  const unclassifiable = addReview(5, null)
  const excluded = addReview(6, 'four', 'round', true)

  closeDatabaseForFixture()
  migrateDatabase()

  expect(
    db()
      .query('SELECT number,round FROM review WHERE number BETWEEN 1 AND 6 ORDER BY number')
      .all(),
  ).toEqual([
    { number: 1, round: 1 },
    { number: 2, round: 2 },
    { number: 3, round: 1 },
    { number: 4, round: null },
    { number: 5, round: null },
    { number: 6, round: 3 },
  ])
  expect(
    db()
      .query<{ round: number }, [string]>(
        `SELECT json_extract(payload,'$.round') AS round
         FROM outbox WHERE kind='review' AND row_id=? ORDER BY id DESC LIMIT 1`,
      )
      .get(second),
  ).toEqual({ round: 2 })
  expect(
    db()
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM outbox WHERE kind='review' AND row_id=?",
      )
      .get(first),
  ).toEqual({ count: 2 })
  expect(
    db()
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM outbox WHERE kind='review' AND row_id=?",
      )
      .get(supplementary),
  ).toEqual({ count: 1 })
  expect(db().query('SELECT round FROM review WHERE record_id=?').get(unclassifiable)).toEqual({
    round: null,
  })
  expect(db().query('SELECT round FROM review WHERE record_id=?').get(excluded)).toEqual({
    round: 3,
  })

  closeDatabaseForFixture()
  migrateDatabase()
  expect(
    db()
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM outbox WHERE kind='review' AND row_id=?",
      )
      .get(repeated),
  ).toEqual({ count: 2 })
})

describe('standard hosted-store access', () => {
  let priorRecordApiUrl: string | undefined
  beforeEach(() => {
    priorRecordApiUrl = process.env.BOTTEGA_RECORD_API_URL
    process.env.BOTTEGA_RECORD_API_URL = 'https://record.example.test'
  })
  afterEach(() => {
    if (priorRecordApiUrl === undefined) delete process.env.BOTTEGA_RECORD_API_URL
    else process.env.BOTTEGA_RECORD_API_URL = priorRecordApiUrl
  })

  test('guards hosted tables while local numbering remains available', () => {
    const database = migratedTestDatabase()
    database
      .query(
        "INSERT INTO record_install_binding(id,bound_at,record_origin) VALUES (1,'at','https://record.example.test')",
      )
      .run()
    try {
      const accessed = STANDARD_OPEN_HOOKS.access!(database)
      expect(() => accessed.query('SELECT 1 FROM task_flow')).toThrow(
        'task_flow is held by the hosted record on this install; read or write it through the record API',
      )
      expect(nextEntityNumber(accessed, 'run')).toBe(1)
      expect(nextEntityNumber(accessed, 'review')).toBe(1)
      expect(nextEntityNumber(accessed, 'board_message')).toBe(1)
    } finally {
      database.close()
    }
  })
})
