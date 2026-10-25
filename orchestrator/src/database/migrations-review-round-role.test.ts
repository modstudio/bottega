import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from './migrations.ts'
import { migrationBoundaryTestDatabase } from './test-database.fixture.ts'

const MIGRATION = '0163_review_round_role'

test('marks only completed undeclared blast-radius-only reviews as supplementary', () => {
  const database = migrationBoundaryTestDatabase(MIGRATION)
  try {
    const undeclaredProject = newRecordId()
    const declaredProject = newRecordId()
    const malformedProject = newRecordId()
    database
      .query("INSERT INTO project(record_id,name,path,settings) VALUES (?,?,?,'{}')")
      .run(undeclaredProject, 'undeclared', '/undeclared')
    database
      .query('INSERT INTO project(record_id,name,path,settings) VALUES (?,?,?,?)')
      .run(
        declaredProject,
        'declared',
        '/declared',
        JSON.stringify({ review: { lenses: [{ lens: 'issue-blast-radius' }] } }),
      )
    database
      .query("INSERT INTO project(record_id,name,path,settings) VALUES (?,?,?,'not json')")
      .run(malformedProject, 'malformed', '/malformed')

    const addReview = (projectId: string, lenses: string[]) => {
      const reviewId = newRecordId()
      database
        .query(
          "INSERT INTO review(record_id,number,recorded_at,completed_at,project_record_id) VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM review),'at','done',?)",
        )
        .run(reviewId, projectId)
      for (const lens of lenses) {
        const runId = newRecordId()
        database
          .query(
            "INSERT INTO run(record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id) VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'at','codex','review-lens','sha',1,'head','ok',?)",
          )
          .run(runId, projectId)
        database
          .query(
            `INSERT INTO review_lens(record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
             VALUES (?,?,?,?,'codex','[]','[]','[]','[]')`,
          )
          .run(newRecordId(), reviewId, runId, lens)
      }
      return reviewId
    }

    const supplementary = addReview(undeclaredProject, ['issue-blast-radius'])
    const zeroLens = addReview(undeclaredProject, [])
    const mixed = addReview(undeclaredProject, ['issue-blast-radius', 'correctness'])
    const declared = addReview(declaredProject, ['issue-blast-radius'])
    const malformed = addReview(malformedProject, ['issue-blast-radius'])

    expect(applyMigrations(database)).toContain(MIGRATION)
    const recordedRun = newRecordId()
    const recordedReview = newRecordId()
    database
      .query(
        `INSERT INTO run(record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,project_record_id,review_role)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'at','codex','review-lens','sha',1,'head','ok',?,'round')`,
      )
      .run(recordedRun, undeclaredProject)
    database
      .query(
        `INSERT INTO review(record_id,number,recorded_at,completed_at,project_record_id,role)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM review),'at','done',?,'round')`,
      )
      .run(recordedReview, undeclaredProject)
    database
      .query(
        `INSERT INTO review_lens(record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
         VALUES (?,?,?,'issue-blast-radius','codex','[]','[]','[]','[]')`,
      )
      .run(newRecordId(), recordedReview, recordedRun)
    expect(applyMigrations(database)).toEqual([])
    const role = (reviewId: string) =>
      database
        .query<{ role: string }, [string]>('SELECT role FROM review WHERE record_id=?')
        .get(reviewId)?.role
    expect(role(supplementary)).toBe('supplementary')
    expect(role(zeroLens)).toBe('round')
    expect(role(mixed)).toBe('round')
    expect(role(declared)).toBe('round')
    expect(role(malformed)).toBe('round')
    expect(role(recordedReview)).toBe('round')
    expect(() => database.query("UPDATE review SET role='other'").run()).toThrow()
    expect(() => database.query("UPDATE run SET review_role='other'").run()).toThrow()
  } finally {
    database.close()
  }
})
