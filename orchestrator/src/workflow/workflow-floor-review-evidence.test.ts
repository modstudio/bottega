import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record/schema.ts'
import type { TriageReviewRow } from '../review/review-group.ts'
import { database, gather, insertRun, projectId } from './workflow-floor-evidence.fixture.ts'
import { reviewRoundsHaveTriageEvidence } from './workflow-floor-evidence.ts'

const review = (number: number, graded: boolean): TriageReviewRow => ({
  reviewRecordId: `review-${number}`,
  reviewNumber: number,
  recordedAt: '2026-10-27T00:00:00Z',
  completedAt: '2026-10-27T00:01:00Z',
  tier: 1,
  role: 'round',
  patchId: 'patch',
  zeroContextPatchId: 'patch',
  pathSet: '["change.ts"]',
  lensIdentities: ['correctness'],
  lenses: [{ recordId: `lens-${number}`, graded, settled: true }],
  findings: [],
})

test('workflow review evidence rejects rounds made only of delivery-none lenses', () => {
  expect(reviewRoundsHaveTriageEvidence([review(1, false), review(2, false)])).toBe(false)
})

test('workflow review evidence accepts one graded review plus one delivery-none review', () => {
  expect(reviewRoundsHaveTriageEvidence([review(1, true), review(2, false)])).toBe(true)
})

test('legacy floor review includes an undisposed finding from the measured review round', async () => {
  const d = database()
  const project = projectId(d, 'fixture')
  const runIds = [
    insertRun(d, { project: 'fixture', launchKey: 'DEV-977', branch: 'DEV-977-work' }),
    insertRun(d, { project: 'fixture', launchKey: 'DEV-977', branch: 'DEV-977-work' }),
  ]
  const reviewIds = [newRecordId(), newRecordId()]
  d.query(
    `INSERT INTO review
       (record_id,number,recorded_at,completed_at,project_record_id,patch_id,zero_context_patch_id,path_set,tier)
     VALUES
       (?,1,'2026-10-27T00:00:00Z','2026-10-27T00:01:00Z',?,'same-patch',NULL,'["src/change.ts"]',1),
       (?,2,'2026-10-27T00:02:00Z','2026-10-27T00:03:00Z',?,'same-patch','measured-patch','["src/change.ts"]',1)`,
  ).run(reviewIds[0]!, project, reviewIds[1]!, project)
  const lensIds = [newRecordId(), newRecordId()]
  const insertLens = d.query(
    `INSERT INTO review_lens
       (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify,
        reproduced,coverage,limits,overlap)
     VALUES (?, ?, ?, 'correctness','codex','[]','["src/change.ts"]','[]','[]','all','adequate','named','unique')`,
  )
  insertLens.run(lensIds[0]!, reviewIds[0]!, runIds[0]!)
  insertLens.run(lensIds[1]!, reviewIds[1]!, runIds[1]!)
  d.query(
    `INSERT INTO review_finding
       (record_id,review_record_id,review_lens_record_id,ordinal,severity,location,evidence,proposed_correction)
     VALUES (?, ?, ?, 1, 'high', 'src/change.ts:1', 'broken', 'correct it')`,
  ).run(newRecordId(), reviewIds[1]!, lensIds[1]!)

  expect((await gather(d, { review: reviewIds[0] })).review).toMatchObject({
    recordId: reviewIds[0],
    allFindingsDisposed: false,
  })
})
