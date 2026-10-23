import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations, applyMigrationsBefore } from './migrations.ts'

test('review round backfill numbers one task across branch names', () => {
  const database = new Database(':memory:')
  applyMigrationsBefore(database, '0146_review_round_selection_reason')
  const project = newRecordId()
  database
    .query(
      "INSERT INTO project (record_id,name,path,settings) VALUES (?,'fixture','/fixture','{}')",
    )
    .run(project)

  const addReview = (number: number, branch: string, launchKey: string | null, patch: string) => {
    const run = newRecordId()
    const review = newRecordId()
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,model,lens,job,project_record_id,branch,launch_key,
          prompt_sha,prompt_bytes,prompt_head,status)
         VALUES (?,?,?,'codex','model','correctness','review-lens',?,?,?,'sha',1,'head','ok')`,
      )
      .run(run, number, `2026-10-0${number}T00:00:00Z`, project, branch, launchKey)
    database
      .query(
        `INSERT INTO review (record_id,number,recorded_at,patch_id,path_set)
         VALUES (?,?,?,?, '["change.ts"]')`,
      )
      .run(review, number, `2026-10-0${number}T01:00:00Z`, patch)
    database
      .query(
        `INSERT INTO review_lens
         (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
         VALUES (?,?,?,'correctness','codex','[]','[]','[]','[]')`,
      )
      .run(newRecordId(), review, run)
  }

  addReview(1, 'DEV-1618-first', 'DEV-1618', 'one')
  addReview(2, 'DEV-1618-reworked', null, 'two')
  addReview(3, 'DEV-1618-third', 'DEV-1618', 'one')
  addReview(4, 'DEV-999-other', null, 'other')
  addReview(5, 'DEV-1618-empty-patch', 'DEV-1618', '   ')

  applyMigrations(database)

  expect(database.query('SELECT number,round FROM review ORDER BY number').all()).toEqual([
    { number: 1, round: 1 },
    { number: 2, round: 2 },
    { number: 3, round: 1 },
    { number: 4, round: 1 },
    { number: 5, round: null },
  ])

  database.query('UPDATE review SET round=42 WHERE number=2').run()
  applyMigrations(database)
  expect(database.query('SELECT round FROM review WHERE number=2').get()).toEqual({ round: 42 })
  database.close()
})
