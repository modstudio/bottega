import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { reviewsForTriage } from './review-group.ts'
import { applicableRoundLensPlan, roundLensFacts, roundLensPlan } from './review-round-lens-plan.ts'

describe('round lens plan', () => {
  test('an initial round lists every relevant lens', () => {
    expect(
      roundLensPlan({
        relevantLenses: ['correctness', 'craft', 'architecture'],
        completedLenses: [],
        latestAcceptedOrModifiedLenses: [],
        newlyTouchedLenses: [],
      }),
    ).toEqual(['correctness', 'craft', 'architecture'])
  })

  test('a later round keeps findings and newly touched concerns but drops a clean lens', () => {
    expect(
      roundLensPlan({
        relevantLenses: ['correctness', 'craft', 'test-quality', 'architecture', 'safety'],
        completedLenses: ['correctness', 'craft', 'test-quality', 'architecture', 'safety'],
        latestAcceptedOrModifiedLenses: ['correctness', 'craft', 'test-quality'],
        newlyTouchedLenses: ['safety'],
      }),
    ).toEqual(['correctness', 'craft', 'test-quality', 'safety'])
  })

  test('a never-completed relevant lens remains in a later round', () => {
    expect(
      roundLensPlan({
        relevantLenses: ['correctness', 'craft'],
        completedLenses: ['correctness'],
        latestAcceptedOrModifiedLenses: [],
        newlyTouchedLenses: [],
      }),
    ).toEqual(['craft'])
  })

  test('a later round treats only path-scoped lenses as newly touched', () => {
    expect(
      applicableRoundLensPlan({
        relevant: {
          lenses: [
            'correctness',
            'craft',
            'test-quality',
            'architecture',
            'migration-safety',
            'safety',
          ],
        },
        facts: {
          completedLenses: [
            'correctness',
            'craft',
            'test-quality',
            'architecture',
            'migration-safety',
            'safety',
          ],
          latestAcceptedOrModifiedLenses: ['correctness', 'craft', 'test-quality'],
        },
        postFix: {
          kind: 're-lens',
          reviewNumber: 2,
          reviewedTip: 'reviewed-tip',
          tierThreePaths: ['orchestrator/src/review/review-round-lens-plan.ts'],
          applicability: {
            lenses: [
              'correctness',
              'craft',
              'test-quality',
              'architecture',
              'migration-safety',
              'safety',
            ],
          },
        },
        pathScopedLenses: ['migration-safety', 'safety'],
      }),
    ).toEqual({
      lenses: ['correctness', 'craft', 'test-quality', 'migration-safety', 'safety'],
    })
  })

  test('an unscoped lens that never completed is still listed', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: ['correctness', 'architecture', 'safety'] },
        facts: {
          completedLenses: ['correctness', 'safety'],
          latestAcceptedOrModifiedLenses: [],
        },
        postFix: {
          kind: 're-lens',
          reviewNumber: 2,
          reviewedTip: 'reviewed-tip',
          tierThreePaths: ['orchestrator/src/review/review-round-lens-plan.ts'],
          applicability: { lenses: ['correctness', 'architecture', 'safety'] },
        },
        pathScopedLenses: ['safety'],
      }),
    ).toEqual({ lenses: ['architecture', 'safety'] })
  })

  test('no newly risky paths still lists a relevant lens that never completed', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: ['correctness', 'safety'] },
        facts: {
          completedLenses: ['correctness'],
          latestAcceptedOrModifiedLenses: ['correctness'],
        },
        postFix: {
          kind: 'no-round-needed',
          reviewNumber: 1,
          reviewedTip: 'reviewed-tip',
          tierThreePaths: [],
          applicability: { lenses: [] },
        },
        pathScopedLenses: ['safety'],
      }),
    ).toEqual({ lenses: ['safety'] })
  })

  test('no newly risky paths needs no round when every relevant lens completed', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: ['correctness', 'safety'] },
        facts: {
          completedLenses: ['correctness', 'safety'],
          latestAcceptedOrModifiedLenses: ['correctness'],
        },
        postFix: {
          kind: 'no-round-needed',
          reviewNumber: 1,
          reviewedTip: 'reviewed-tip',
          tierThreePaths: [],
          applicability: { lenses: [] },
        },
        pathScopedLenses: ['safety'],
      }),
    ).toEqual({ lenses: [] })
  })

  const sixLenses = [
    'correctness',
    'frontend-bug-hunting',
    'decision-conformance',
    'architecture',
    'craft',
    'test-quality',
  ] as const

  test('a test-only commit after a clean six-lens round needs no round when the tip is unidentified', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: [...sixLenses] },
        facts: {
          completedLenses: [...sixLenses],
          latestAcceptedOrModifiedLenses: [],
        },
        postFix: { kind: 'reviewed-tip-unidentified', reviewNumber: 1 },
        pathScopedLenses: ['test-quality'],
      }),
    ).toEqual({ lenses: [] })
  })

  test('a test-only commit after findings re-runs only those lenses when the tip is unidentified', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: [...sixLenses] },
        facts: {
          completedLenses: [...sixLenses],
          latestAcceptedOrModifiedLenses: ['test-quality'],
        },
        postFix: { kind: 'reviewed-tip-unidentified', reviewNumber: 1 },
        pathScopedLenses: ['test-quality'],
      }),
    ).toEqual({ lenses: ['test-quality'] })
  })

  test('an unidentified tip with completed lenses applies the funnel, not the full set', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: [...sixLenses] },
        facts: {
          completedLenses: [...sixLenses],
          latestAcceptedOrModifiedLenses: ['correctness', 'craft'],
        },
        postFix: { kind: 'reviewed-tip-unidentified', reviewNumber: 1 },
        pathScopedLenses: ['test-quality'],
      }),
    ).toEqual({ lenses: ['correctness', 'craft'] })
  })

  test('facts use the latest prior round and attribute accepted and modified findings by lens', () => {
    const database = migratedTestDatabase()
    const projectRecordId = newRecordId()
    const reviewRecordId = newRecordId()
    const currentReviewRecordId = newRecordId()
    const olderReviewRecordId = newRecordId()
    database
      .query(
        "INSERT INTO project (record_id,name,path,settings) VALUES (?,'fixture','/fixture','{}')",
      )
      .run(projectRecordId)
    database
      .query(
        `INSERT INTO review (record_id,number,recorded_at,completed_at,tier,patch_id,path_set)
         VALUES (?,4,'2026-10-20T00:00:00Z','2026-10-20T01:00:00Z',3,'latest','["a.ts"]')`,
      )
      .run(reviewRecordId)
    database
      .query(
        `INSERT INTO review (record_id,number,recorded_at,completed_at,tier,patch_id,path_set)
         VALUES (?,5,'2026-10-21T00:00:00Z','2026-10-21T01:00:00Z',3,'current','["a.ts"]'),
                (?,3,'2026-10-19T00:00:00Z','2026-10-19T01:00:00Z',3,'older','["a.ts"]')`,
      )
      .run(currentReviewRecordId, olderReviewRecordId)
    const addLensFinding = (
      targetReviewRecordId: string,
      lens: string,
      disposition: string,
      ordinal: number,
    ) => {
      const runRecordId = newRecordId()
      const lensRecordId = newRecordId()
      database
        .query(
          `INSERT INTO run
             (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,project_record_id,branch)
           VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-10-20','codex','review-lens','sha',1,'head','ok','fixture',?,'DEV-1563')`,
        )
        .run(runRecordId, projectRecordId)
      database
        .query(
          `INSERT INTO review_lens
             (record_id,review_record_id,run_record_id,lens,agent,model,standards_read,files_covered,commands_run,could_not_verify,
              reproduced,coverage,limits,overlap)
           VALUES (?,?,?,?,'codex','model','[]','["a.ts"]','[]','[]','all','adequate','absent','none')`,
        )
        .run(lensRecordId, targetReviewRecordId, runRecordId, lens)
      database
        .query(
          `INSERT INTO review_finding
             (record_id,review_record_id,review_lens_record_id,ordinal,severity,location,evidence,proposed_correction,disposition)
           VALUES (?,?,?,?,'medium','a.ts:1','evidence','correction',?)`,
        )
        .run(newRecordId(), targetReviewRecordId, lensRecordId, ordinal, disposition)
    }
    addLensFinding(reviewRecordId, 'correctness', 'accepted', 1)
    addLensFinding(reviewRecordId, 'craft', 'modified', 2)
    addLensFinding(reviewRecordId, 'architecture', 'rejected', 3)
    addLensFinding(currentReviewRecordId, 'migration-safety', 'accepted', 1)
    addLensFinding(olderReviewRecordId, 'safety', 'accepted', 1)

    const branchReviews = reviewsForTriage(database, {
      project: 'fixture',
      branch: 'DEV-1563',
      patchId: 'current',
      pathSet: ['a.ts'],
    }).branchReviews
    expect(roundLensFacts(branchReviews, { patchId: 'current', pathSet: '["a.ts"]' })).toEqual({
      completedLenses: ['correctness', 'craft', 'architecture', 'safety'],
      latestAcceptedOrModifiedLenses: ['correctness', 'craft'],
    })
    database.close()
  })
})
