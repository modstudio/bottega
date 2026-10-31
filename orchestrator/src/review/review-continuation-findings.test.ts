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
  options: { patchId?: string | null; pathSet?: string[] | null; headCommit?: string | null } = {},
): void {
  const reviewRecordId = newRecordId()
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
    .query('UPDATE run SET head_commit=? WHERE record_id=?')
    .run(options.headCommit ?? null, run.id)
  database
    .query(
      `INSERT INTO review (number,record_id,recorded_at,completed_at,patch_id,path_set,tier)
       VALUES (?,?,'2026-10-12','2026-10-12',?,?,2)`,
    )
    .run(
      reviewId,
      reviewRecordId,
      options.patchId === undefined ? 'current-patch' : options.patchId,
      options.pathSet === null ? null : JSON.stringify(options.pathSet ?? ['one.ts']),
    )
  const reviewLens = database
    .query<{ record_id: string }, [string, string, string]>(
      `INSERT INTO review_lens
         (record_id,review_record_id,run_record_id,lens,agent,model,standards_read,files_covered,commands_run,
          could_not_verify,reproduced,coverage,limits,overlap)
       VALUES ('${newRecordId()}', ?, ?, ?, 'codex','model','[]','["one.ts"]','[]','[]','all','adequate','absent','none')
       RETURNING record_id`,
    )
    .get(reviewRecordId, run.id, lens)!
  for (const finding of findings) {
    database
      .query(
        `INSERT INTO review_finding
           (record_id,review_record_id,review_lens_record_id,ordinal,severity,location,evidence,proposed_correction,
            disposition,triaged_severity)
         VALUES ('${newRecordId()}',?,?,?,?,?,?,?, ?,?)`,
      )
      .run(
        reviewRecordId,
        reviewLens.record_id,
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

  expect(rendered).toContain('1. Finding 10/1')
  expect(rendered).toContain('Lens: correctness')
  expect(rendered).toContain('Severity: critical (triaged)')
  expect(rendered).toContain('Location: correctness.ts:1')
  expect(rendered).toContain('Evidence: correctness evidence 1')
  expect(rendered).toContain('Proposed correction: correctness correction 1')
  expect(rendered).toContain('2. Finding 20/2')
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

test('refuses when the branch review lineage has no rounds and names its remedy', () => {
  const database = fixture()
  expect(() => continuationFindings(database, group, 'message')).toThrow(
    'the review lineage for branch DEV-1258 has no measured review rounds\n' +
      'cleared by: run and judge the review lenses for the current change',
  )
})

test('refuses a modified finding without an architect message', () => {
  const finding: ContinuationFinding = {
    reviewNumber: 1,
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
    reviewNumber: 1,
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

test('delivers the latest lineage round after the branch change group moves', () => {
  const database = fixture()
  addReview(database, 40, 'correctness', [{ ordinal: 1, disposition: 'accepted' }], {
    patchId: 'reviewed-patch',
    headCommit: '1234567890abcdef',
  })

  const resolved = continuationFindings(database, group, undefined, () => ({
    reviewedSha: '1234567890abcdef',
    commitLines: ['7654321 Architect fix', 'abcdef0 Follow-up'],
    omittedOlder: false,
  }))
  expect(resolved).toContain(
    'REVIEW FINDINGS\n\nThese findings were reviewed at 1234567. The branch has moved since by:\n' +
      '7654321 Architect fix\nabcdef0 Follow-up\n\n1. Finding 40/1',
  )
  expect(continuationFindings(database, group, undefined)).toContain(
    'REVIEW FINDINGS\n\nThe reviewed commit is unknown.',
  )
})

test('delivers the newest complete round, not an older one matching the current change', () => {
  const database = fixture()
  addReview(database, 43, 'correctness', [{ ordinal: 1, disposition: 'accepted' }])
  addReview(database, 44, 'safety', [{ ordinal: 2, disposition: 'accepted' }], {
    patchId: 'newer-patch',
  })

  const rendered = continuationFindings(database, group, undefined)
  expect(rendered).toContain('1. Finding 44/2')
  expect(rendered).not.toContain('Finding 43/1')
})

test('a newest review with no change measurement is not a round to deliver', () => {
  const database = fixture()
  addReview(database, 45, 'correctness', [{ ordinal: 1, disposition: 'accepted' }])
  addReview(database, 46, 'safety', [{ ordinal: 2, disposition: 'accepted' }], {
    patchId: null,
    pathSet: null,
  })

  const rendered = continuationFindings(database, group, undefined)
  expect(rendered).toContain('1. Finding 45/1')
  expect(rendered).not.toContain('Finding 46/2')
  expect(rendered).not.toContain('reviewed at')
})

test.each([
  [
    'commits since could not be read',
    { reviewedSha: '1234567890abcdef', commitLines: null, omittedOlder: false },
    'These findings were reviewed at 1234567. The commits since it could not be read.',
  ],
  [
    'reviewed sha is still the tip',
    { reviewedSha: '1234567890abcdef', commitLines: [], omittedOlder: false },
    'These findings were reviewed at 1234567. That is still the branch tip, but the change under review differs from the one reviewed.',
  ],
  [
    'older commits were left out',
    { reviewedSha: '1234567890abcdef', commitLines: ['7654321 Fix'], omittedOlder: true },
    'The branch has moved since by:\n7654321 Fix\n(older commits not listed)',
  ],
] as const)('the moved-branch notice says so when the %s', (_name, staleness, expected) => {
  const finding: ContinuationFinding = {
    reviewNumber: 1,
    ordinal: 1,
    lens: 'correctness',
    reviewerSeverity: 'high',
    triagedSeverity: null,
    disposition: 'accepted',
    location: 'one.ts:1',
    evidence: 'evidence',
    proposedCorrection: 'correction',
  }
  expect(renderContinuationFindings([finding], undefined, staleness)).toContain(expected)
})

test('a matching current group preserves the previous rendered text exactly', () => {
  const database = fixture()
  addReview(database, 1, 'correctness', [{ ordinal: 1, disposition: 'accepted' }])

  expect(continuationFindings(database, group, undefined)).toBe(
    'REVIEW FINDINGS\n\n' +
      '1. Finding 1/1\n' +
      '   Lens: correctness\n' +
      '   Severity: medium (reviewer)\n' +
      '   Location: correctness.ts:1\n' +
      '   Evidence: correctness evidence 1\n' +
      '   Proposed correction: correctness correction 1\n\n' +
      'Apply each item and nothing else, and in the summary answer each item by its number as ' +
      'applied, or not applied and why.',
  )
})

test('a newer incomplete round refuses instead of falling back to an older complete round', () => {
  const database = fixture()
  addReview(database, 41, 'correctness', [{ ordinal: 1, disposition: 'accepted' }], {
    patchId: 'older-patch',
  })
  addReview(database, 42, 'safety', [{ ordinal: 2, disposition: null }])

  expect(() => continuationFindings(database, group, 'message')).toThrow(
    'review round is not triage-complete:\nreview 42: untriaged finding ordinal(s) 2',
  )
})
