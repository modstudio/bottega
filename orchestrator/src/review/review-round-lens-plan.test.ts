import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { reviewsForTriage } from './review-group.ts'
import {
  applicableRoundLensPlan,
  reviewRoundForBudget,
  roundLensFacts,
  roundLensPlan,
} from './review-round-lens-plan.ts'

const facts = (
  overrides: Partial<Parameters<typeof applicableRoundLensPlan>[0]['facts']> = {},
) => ({
  reviewedPathsByLens: {},
  completedLenses: [],
  satisfiedSecondOpinionLenses: [],
  latestAcceptedOrModifiedLenses: [],
  ...overrides,
})

describe('round lens plan', () => {
  const round = {
    lenses: ['safety'],
    secondOpinion: 'safety',
    lensBases: { safety: 'critical paths' },
    secondOpinionBasis: 'independent evidence',
  }

  test('keeps the funnel round when the budget starts it', () => {
    expect(
      reviewRoundForBudget(round, {
        roundsUsed: 1,
        ceiling: 3,
        currentChangeCounted: false,
        startsNewRound: true,
        wouldExceedCeiling: false,
      }),
    ).toBe(round)
  })

  test.each([
    ['the round ceiling is exhausted', true, true],
    ['the architect reads the fix', false, false],
  ] as const)('returns an empty round when %s', (_label, startsNewRound, wouldExceedCeiling) => {
    expect(
      reviewRoundForBudget(round, {
        roundsUsed: 3,
        ceiling: 3,
        currentChangeCounted: false,
        startsNewRound,
        wouldExceedCeiling,
      }),
    ).toEqual({ lenses: [] })
  })

  test('an initial round lists every relevant lens', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: ['correctness', 'craft', 'architecture'] },
        facts: facts(),
        postFix: { kind: 'no-completed-round' },
        fixPathsByLens: {},
      }),
    ).toEqual({
      round: { lenses: ['correctness', 'craft', 'architecture'] },
      admissionRequired: { lenses: ['correctness', 'craft', 'architecture'] },
    })
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
        facts: facts({
          reviewedPathsByLens: { correctness: ['src/reviewed.ts'] },
          completedLenses: ['correctness'],
        }),
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
    ).toEqual({ round: { lenses: [] }, admissionRequired: { lenses: ['correctness'] } })
  })

  test('a fix touching only paths a clean scoped lens already reviewed selects nothing', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: ['safety'] },
        facts: facts({
          reviewedPathsByLens: { safety: ['src/risky.ts'] },
          completedLenses: ['safety'],
        }),
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
    ).toEqual({ round: { lenses: [] }, admissionRequired: { lenses: ['safety'] } })
  })

  test("a fix touching a new path inside a lens's scope selects that lens", () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: ['safety'] },
        facts: facts({
          reviewedPathsByLens: { safety: ['src/reviewed.ts'] },
          completedLenses: ['safety'],
        }),
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
    ).toEqual({
      round: { lenses: ['safety'] },
      admissionRequired: { lenses: ['safety'] },
    })
  })

  test('a no-round-needed decision selects no round lenses', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: ['correctness', 'safety'] },
        facts: facts({ completedLenses: ['correctness', 'safety'] }),
        postFix: {
          kind: 'no-round-needed',
          reviewNumber: 1,
          reviewedTip: 'reviewed-tip',
          tierThreePaths: [],
          applicability: { lenses: [] },
        },
        fixPathsByLens: {},
      }),
    ).toEqual({
      round: { lenses: [] },
      admissionRequired: { lenses: ['correctness', 'safety'] },
    })
  })

  const sixLenses = [
    'correctness',
    'frontend-bug-hunting',
    'decision-conformance',
    'architecture',
    'craft',
    'test-quality',
  ] as const

  test('an unidentified tip with completed lenses applies the funnel, not the full set', () => {
    expect(
      applicableRoundLensPlan({
        relevant: { lenses: [...sixLenses] },
        facts: facts({
          completedLenses: [...sixLenses],
          latestAcceptedOrModifiedLenses: ['correctness', 'craft'],
        }),
        postFix: { kind: 'reviewed-tip-unidentified', reviewNumber: 1 },
        fixPathsByLens: {},
      }),
    ).toEqual({
      round: { lenses: ['correctness', 'craft'] },
      admissionRequired: { lenses: [...sixLenses] },
    })
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
      completedLenses: ['migration-safety', 'correctness', 'craft', 'architecture', 'safety'],
      satisfiedSecondOpinionLenses: [],
      latestAcceptedOrModifiedLenses: ['correctness', 'craft'],
    })
    database.close()
  })
})
