import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { closeDatabaseForFixture, db, migrateDatabase } from '../database/db.ts'
import { enqueueReview } from '../review/review-outbox.ts'

test('standard after-initialize hooks re-enqueue a migrated review whose round changed', () => {
  const review = newRecordId()
  db()
    .query(
      `INSERT INTO review (record_id,number,recorded_at,round)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM review),'2026-10-23T00:00:00Z',1)`,
    )
    .run(review)
  enqueueReview(db(), review)
  db().query('UPDATE review SET round=2 WHERE record_id=?').run(review)

  closeDatabaseForFixture()
  migrateDatabase()

  expect(
    db()
      .query<{ round: number }, [string]>(
        `SELECT json_extract(payload,'$.round') AS round
         FROM outbox WHERE kind='review' AND row_id=? ORDER BY id DESC LIMIT 1`,
      )
      .get(review),
  ).toEqual({ round: 2 })
  expect(
    db()
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM outbox WHERE kind='review' AND row_id=?",
      )
      .get(review),
  ).toEqual({ count: 2 })
})
