import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { reviewFunnelYieldCells } from './review-funnel-yield.ts'

test('yield cells use run stack and the most recent eligible lens rows in the window', () => {
  const database = migratedTestDatabase()
  const project = newRecordId()
  database
    .query("INSERT INTO project(record_id,name,path,settings) VALUES (?,'fixture','/fixture','{}')")
    .run(project)
  const addReview = (number: number, disposition: 'accepted' | 'rejected') => {
    const run = newRecordId()
    const review = newRecordId()
    const lens = newRecordId()
    const finding = newRecordId()
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id,stack)
         VALUES (?,?,?,'codex','review-lens','sha',1,'head','ok',?,'typescript')`,
      )
      .run(run, number, `2026-11-${String(number).padStart(2, '0')}`, project)
    database
      .query(
        `INSERT INTO review(record_id,number,recorded_at,completed_at,tier,project_record_id)
         VALUES (?,?,?,?,1,?)`,
      )
      .run(
        review,
        number,
        `2026-11-${String(number).padStart(2, '0')}`,
        `2026-11-${String(number).padStart(2, '0')}T01:00:00Z`,
        project,
      )
    database
      .query(
        `INSERT INTO review_lens
         (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
         VALUES (?,?,?,'craft','codex','[]','[]','[]','[]')`,
      )
      .run(lens, review, run)
    database
      .query(
        `INSERT INTO review_finding
         (record_id,review_record_id,review_lens_record_id,ordinal,severity,location,evidence,proposed_correction,disposition)
         VALUES (?,?,?,1,'medium','a.ts:1','evidence','correction',?)`,
      )
      .run(finding, review, lens, disposition)
    if (disposition === 'accepted') {
      database
        .query(
          `INSERT INTO review_finding
           (record_id,review_record_id,review_lens_record_id,ordinal,severity,location,evidence,proposed_correction,disposition,duplicate_of_finding_record_id)
           VALUES (?,?,?,2,'medium','a.ts:2','duplicate evidence','correction','accepted',?)`,
        )
        .run(newRecordId(), review, lens, finding)
    }
  }
  addReview(1, 'accepted')
  addReview(2, 'rejected')

  expect(reviewFunnelYieldCells(database, 1)).toEqual([
    { lens: 'craft', stack: 'typescript', tier: 1, accepted: 0, unique: 0, triaged: 1 },
  ])
  expect(reviewFunnelYieldCells(database, 2)).toEqual([
    { lens: 'craft', stack: 'typescript', tier: 1, accepted: 2, unique: 1, triaged: 3 },
  ])
  database.close()
})
