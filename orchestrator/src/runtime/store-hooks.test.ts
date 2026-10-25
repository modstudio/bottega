import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun } from '../../test/fixtures/store.ts'
import { closeDatabaseForFixture, db, migrateDatabase } from '../database/db.ts'
import { enqueueReview } from '../review/review-outbox.ts'

test('standard after-initialize hooks backfill classifiable rounds and re-enqueue them once', () => {
  const project = newRecordId()
  db()
    .query("INSERT INTO project (record_id,name,path,settings) VALUES (?,'adanim','/adanim','{}')")
    .run(project)
  const addReview = (
    number: number,
    patch: string | null,
    role: 'round' | 'supplementary' = 'round',
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
      .query('UPDATE run SET branch=?,project_record_id=? WHERE record_id=?')
      .run('worktree-ADN-1004-worktree-teardown', project, run)
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

  closeDatabaseForFixture()
  migrateDatabase()

  expect(
    db()
      .query('SELECT number,round FROM review WHERE number BETWEEN 1 AND 5 ORDER BY number')
      .all(),
  ).toEqual([
    { number: 1, round: 1 },
    { number: 2, round: 2 },
    { number: 3, round: 1 },
    { number: 4, round: null },
    { number: 5, round: null },
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
