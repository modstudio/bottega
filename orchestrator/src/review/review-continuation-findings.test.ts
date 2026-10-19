import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from '../database/migrations.ts'
import {
  type ContinuationFinding,
  continuationFindings,
  renderContinuationFindings,
} from './review-continuation-findings.ts'

const group = {
  project: 'fixture',
  branch: 'DEV-1258',
  patchId: 'current-patch',
  pathSet: ['one.ts'],
}

function fixture(): Database {
  const database = new Database(':memory:')
  applyMigrations(database)
  database
    .query(
      "INSERT INTO project (record_id,name,path,settings) VALUES (?,'fixture','/fixture','{}')",
    )
    .run(newRecordId())
  return database
}

function addReview(
  database: Database,
  reviewId: number,
  lens: string,
  findings: Array<{
    ordinal: number
    disposition: string | null
    severity?: string
    triagedSeverity?: string | null
  }>,
): void {
  const run = database
    .query<{ id: string }, []>(
      `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,project_record_id,branch)
       VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-10-12','codex','review-lens','sha',1,'head','ok','fixture',
               (SELECT record_id FROM project WHERE name='fixture'),'DEV-1258')
       RETURNING record_id AS id`,
    )
    .get()!
  database
    .query(
      `INSERT INTO review (id,record_id,recorded_at,completed_at,patch_id,path_set,tier)
       VALUES (?,'${newRecordId()}','2026-10-12','2026-10-12','current-patch','["one.ts"]',2)`,
    )
    .run(reviewId)
  const reviewLens = database
    .query<{ id: number }, [number, string, string]>(
      `INSERT INTO review_lens
         (record_id,review_id,run_record_id,lens,agent,model,standards_read,files_covered,commands_run,
          could_not_verify,reproduced,coverage,limits,overlap)
       VALUES ('${newRecordId()}', ?, ?, ?, 'codex','model','[]','["one.ts"]','[]','[]','all','adequate','absent','none')
       RETURNING id`,
    )
    .get(reviewId, run.id, lens)!
  for (const finding of findings) {
    database
      .query(
        `INSERT INTO review_finding
           (record_id,review_id,review_lens_id,ordinal,severity,location,evidence,proposed_correction,
            disposition,triaged_severity)
         VALUES ('${newRecordId()}',?,?,?,?,?,?,?, ?,?)`,
      )
      .run(
        reviewId,
        reviewLens.id,
        finding.ordinal,
        finding.severity ?? 'medium',
        `${lens}.ts:${finding.ordinal}`,
        `${lens} evidence ${finding.ordinal}`,
        `${lens} correction ${finding.ordinal}`,
        finding.disposition,
        finding.triagedSeverity ?? null,
      )
  }
}

test('three lenses render only accepted and modified findings in stable attributed order', () => {
  const database = fixture()
  addReview(database, 30, 'safety', [{ ordinal: 1, disposition: 'skipped' }])
  addReview(database, 10, 'correctness', [
    { ordinal: 1, disposition: 'accepted', severity: 'high', triagedSeverity: 'critical' },
  ])
  addReview(database, 20, 'craft', [
    { ordinal: 1, disposition: 'rejected' },
    { ordinal: 2, disposition: 'modified', severity: 'medium' },
  ])

  const rendered = continuationFindings(database, group, 'Use the safer correction.')

  expect(rendered).toContain('1. Review 10, finding 1')
  expect(rendered).toContain('Lens: correctness')
  expect(rendered).toContain('Severity: critical (triaged)')
  expect(rendered).toContain('Location: correctness.ts:1')
  expect(rendered).toContain('Evidence: correctness evidence 1')
  expect(rendered).toContain('Proposed correction: correctness correction 1')
  expect(rendered).toContain('2. Review 20, finding 2')
  expect(rendered).toContain('Severity: medium (reviewer)')
  expect(rendered).toContain(
    "Modified: the architect message overrides the reviewer's proposed correction.",
  )
  expect(rendered).not.toContain('rejected')
  expect(rendered).not.toContain('skipped')
  expect(rendered).toContain('ARCHITECT MESSAGE\n\nUse the safer correction.')
})

test('refuses a round with an untriaged finding and names its remedy', () => {
  const database = fixture()
  addReview(database, 11, 'correctness', [{ ordinal: 3, disposition: null }])
  expect(() => continuationFindings(database, group, 'message')).toThrow(
    new RegExp(`review 11: untriaged finding ordinal\\(s\\) 3[\\s\\S]*${PLATFORM_SLUG} score`),
  )
})

test('refuses a round with no accepted or modified findings', () => {
  const database = fixture()
  addReview(database, 12, 'correctness', [{ ordinal: 1, disposition: 'rejected' }])
  expect(() => continuationFindings(database, group, 'message')).toThrow(
    'continue without --findings',
  )
})

test('refuses a modified finding without an architect message', () => {
  const finding: ContinuationFinding = {
    reviewId: 1,
    ordinal: 1,
    lens: 'correctness',
    reviewerSeverity: 'high',
    triagedSeverity: null,
    disposition: 'modified',
    location: 'one.ts:1',
    evidence: 'evidence',
    proposedCorrection: 'correction',
  }
  expect(() => renderContinuationFindings([finding], undefined)).toThrow(
    'a modified finding requires an architect message',
  )
})

test('omits the architect message section when no message was supplied', () => {
  const finding: ContinuationFinding = {
    reviewId: 1,
    ordinal: 1,
    lens: 'correctness',
    reviewerSeverity: 'high',
    triagedSeverity: null,
    disposition: 'accepted',
    location: 'one.ts:1',
    evidence: 'evidence',
    proposedCorrection: 'correction',
  }
  expect(renderContinuationFindings([finding], undefined)).not.toContain('ARCHITECT MESSAGE')
})
