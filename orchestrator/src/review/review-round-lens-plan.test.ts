import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { reviewsForTriage } from './review-group.ts'
import { applicableRoundLensPlan, roundLensFacts, roundLensPlan } from './review-round-lens-plan.ts'

describe('round lens plan', () => {
  test('an initial round lists every relevant lens', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: ['correctness', 'craft', 'architecture'] },
        facts: {
          reviewedPathsByLens: {},
          latestAcceptedOrModifiedLenses: [],
        },
        postFix: { kind: 'no-completed-round' },
        fixPathsByLens: {},
      }),
    ).toEqual({ lenses: ['correctness', 'craft', 'architecture'] })
  })

  test('an accepted-finding lens still re-runs', () => {
    expect(
      roundLensPlan({
        relevantLenses: ['correctness', 'craft', 'test-quality', 'architecture', 'safety'],
        latestAcceptedOrModifiedLenses: ['correctness', 'craft', 'test-quality'],
        newlyTouchedLenses: ['safety'],
      }),
    ).toEqual(['correctness', 'craft', 'test-quality', 'safety'])
  })

  test('a never-run lens is not selected when a fix only raises the tier', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: ['correctness', 'architecture'] },
        facts: {
          reviewedPathsByLens: { correctness: ['src/reviewed.ts'] },
          latestAcceptedOrModifiedLenses: [],
        },
        postFix: {
          kind: 're-lens',
          reviewNumber: 2,
          reviewedTip: 'reviewed-tip',
          fixPaths: ['src/risky.ts'],
          tierThreePaths: ['src/risky.ts'],
          applicability: { lenses: ['correctness', 'architecture'] },
        },
        fixPathsByLens: {},
      }),
    ).toEqual({ lenses: [] })
  })

  test('a fix touching only paths a clean scoped lens already reviewed selects nothing', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: ['safety'] },
        facts: {
          reviewedPathsByLens: { safety: ['src/risky.ts'] },
          latestAcceptedOrModifiedLenses: [],
        },
        postFix: {
          kind: 're-lens',
          reviewNumber: 2,
          reviewedTip: 'reviewed-tip',
          fixPaths: ['src/risky.ts'],
          tierThreePaths: ['src/risky.ts'],
          applicability: { lenses: ['safety'] },
        },
        fixPathsByLens: { safety: ['src/risky.ts'] },
      }),
    ).toEqual({ lenses: [] })
  })

  test("a fix touching a new path inside a lens's scope selects that lens", () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: ['safety'] },
        facts: {
          reviewedPathsByLens: { safety: ['src/reviewed.ts'] },
          latestAcceptedOrModifiedLenses: [],
        },
        postFix: {
          kind: 're-lens',
          reviewNumber: 2,
          reviewedTip: 'reviewed-tip',
          fixPaths: ['src/new.ts'],
          tierThreePaths: ['src/new.ts'],
          applicability: { lenses: ['safety'] },
        },
        fixPathsByLens: { safety: ['src/new.ts'] },
      }),
    ).toEqual({ lenses: ['safety'] })
  })

  test('no newly risky paths needs no round when every relevant lens completed', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: ['correctness', 'safety'] },
        facts: {
          reviewedPathsByLens: { correctness: ['src/a.ts'], safety: ['src/a.ts'] },
          latestAcceptedOrModifiedLenses: ['correctness'],
        },
        postFix: {
          kind: 'no-round-needed',
          reviewNumber: 1,
          reviewedTip: 'reviewed-tip',
          tierThreePaths: [],
          applicability: { lenses: [] },
        },
        fixPathsByLens: {},
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
          reviewedPathsByLens: {},
          latestAcceptedOrModifiedLenses: [],
        },
        postFix: { kind: 'reviewed-tip-unidentified', reviewNumber: 1 },
        fixPathsByLens: {},
      }),
    ).toEqual({ lenses: [] })
  })

  test('an unidentified tip with completed lenses applies the funnel, not the full set', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: [...sixLenses] },
        facts: {
          reviewedPathsByLens: {},
          latestAcceptedOrModifiedLenses: ['correctness', 'craft'],
        },
        postFix: { kind: 'reviewed-tip-unidentified', reviewNumber: 1 },
        fixPathsByLens: {},
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
      reviewedPathsByLens: {
        correctness: ['a.ts'],
        craft: ['a.ts'],
        architecture: ['a.ts'],
        safety: ['a.ts'],
      },
      latestAcceptedOrModifiedLenses: ['correctness', 'craft'],
    })
    database.close()
  })
})
