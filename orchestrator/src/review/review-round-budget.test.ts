import { describe, expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { addRun, score } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import {
  reviewBudgetForBranch,
  reviewBudgetReport,
  reviewRoundBudgetDecision,
} from './review-round-budget.ts'

describe('review round budget decision', () => {
  test.each([
    ['under the ceiling', 3, 1, false, false],
    ['current change already counted', 1, 1, true, false],
    ['new round reaches the ceiling', 2, 1, false, false],
    ['new round passes the ceiling', 2, 2, false, true],
    ['tier zero permits no rounds', 0, 0, false, true],
  ] as const)('%s', (_name, tier, roundsUsed, currentChangeCounted, wouldExceedCeiling) => {
    expect(reviewRoundBudgetDecision({ tier, roundsUsed, currentChangeCounted })).toEqual({
      roundsUsed,
      ceiling: tier,
      currentChangeCounted,
      startsNewRound: !currentChangeCounted,
      wouldExceedCeiling,
    })
  })
})

function addEvidence(input: {
  branch: string
  project?: string
  launchKey?: string | null
  at: string
  patch: string | null
  tier: 0 | 1 | 2 | 3 | null
  path?: string
  probe?: boolean
  excluded?: boolean
  deliveryNone?: boolean
}): void {
  const review = db()
    .query<{ id: number }, [string, number | null, string | null, string]>(
      `INSERT INTO review (record_id,recorded_at,tier,patch_id,path_set)
       VALUES (?,?,?,?,?) RETURNING id`,
    )
    .get(
      newRecordId(),
      input.at,
      input.tier,
      input.patch,
      JSON.stringify([input.path ?? 'change.ts']),
    )!
  const run = addRun({
    agent: 'codex',
    job: 'review-lens',
    lens: 'correctness',
    probe: input.probe ? 1 : 0,
    startedAt: input.at,
    repo: input.project ?? 'fixture',
  })
  db()
    .query('UPDATE run SET branch=?,launch_key=? WHERE id=?')
    .run(input.branch, input.launchKey === undefined ? 'DEV-1256' : input.launchKey, run)
  if (input.excluded) db().query("UPDATE run SET evidence_excluded='void' WHERE id=?").run(run)
  if (input.deliveryNone) score(run, 'none')
  db()
    .query(
      `INSERT INTO review_lens
       (record_id,review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
       VALUES (?,?,?,'correctness','codex','[]','[]','[]','[]')`,
    )
    .run(newRecordId(), review.id, run)
}

describe('review budget query', () => {
  test('uses yield identity and evidence eligibility without classifying absent history as zero', () => {
    addEvidence({ branch: 'over', at: '2026-10-01T00:00:00Z', patch: 'one', tier: 1 })
    addEvidence({ branch: 'over', at: '2026-10-02T00:00:00Z', patch: 'one', tier: 1 })
    addEvidence({ branch: 'over', at: '2026-10-03T00:00:00Z', patch: 'two', tier: 1 })
    addEvidence({
      branch: 'over',
      at: '2026-10-04T00:00:00Z',
      patch: 'void',
      tier: 1,
      excluded: true,
    })
    addEvidence({
      branch: 'over',
      at: '2026-10-05T00:00:00Z',
      patch: 'probe',
      tier: 1,
      probe: true,
    })
    addEvidence({
      branch: 'over',
      at: '2026-10-06T00:00:00Z',
      patch: 'none',
      tier: 1,
      deliveryNone: true,
    })
    addEvidence({ branch: 'exact', at: '2026-10-01T00:00:00Z', patch: 'one', tier: 2 })
    addEvidence({ branch: 'exact', at: '2026-10-02T00:00:00Z', patch: 'two', tier: 2 })
    addEvidence({ branch: 'no-tier', at: '2026-10-01T00:00:00Z', patch: 'one', tier: null })
    addEvidence({
      branch: 'no-round',
      launchKey: null,
      at: '2026-10-01T00:00:00Z',
      patch: null,
      tier: 0,
    })

    const report = reviewBudgetReport(db())
    expect(report.branches).toEqual([
      {
        project: 'fixture',
        branch: 'over',
        tier: 1,
        rounds: 2,
        firstReviewAt: '2026-10-01T00:00:00Z',
        exceededAt: '2026-10-03T00:00:00Z',
      },
    ])
    expect(report.denominators).toEqual({
      eligibleReviewBranches: 4,
      withRecordedTier: 3,
      withClassifiableRound: 3,
      exactlyAtCeiling: 1,
      overCeiling: 1,
      withoutRecordedTier: 1,
      withoutClassifiableRound: 1,
    })
    expect(reviewBudgetForBranch(db(), 'fixture', 'over', 'dev-1256\0two\0["change.ts"]')).toEqual({
      roundsUsed: 2,
      currentChangeCounted: true,
      eligibleReviewCount: 3,
      unclassifiableReviewCount: 0,
    })
    expect(reviewBudgetForBranch(db(), 'fixture', 'no-reviews', null)).toEqual({
      roundsUsed: 0,
      currentChangeCounted: false,
      eligibleReviewCount: 0,
      unclassifiableReviewCount: 0,
    })
    expect(reviewBudgetForBranch(db(), 'fixture', 'no-round', null)).toEqual({
      roundsUsed: 0,
      currentChangeCounted: false,
      eligibleReviewCount: 1,
      unclassifiableReviewCount: 1,
    })
  })

  test('keeps matching branch names separate by run project', () => {
    addEvidence({
      project: 'alpha',
      branch: 'DEV-1256-shared',
      at: '2026-10-01T00:00:00Z',
      patch: 'one',
      tier: 1,
    })
    addEvidence({
      project: 'alpha',
      branch: 'DEV-1256-shared',
      at: '2026-10-02T00:00:00Z',
      patch: 'two',
      tier: 1,
    })
    addEvidence({
      project: 'beta',
      branch: 'DEV-1256-shared',
      at: '2026-10-03T00:00:00Z',
      patch: 'one',
      tier: 1,
    })

    expect(reviewBudgetReport(db())).toMatchObject({
      branches: [
        {
          project: 'alpha',
          branch: 'DEV-1256-shared',
          rounds: 2,
          tier: 1,
        },
      ],
      denominators: {
        eligibleReviewBranches: 2,
        withRecordedTier: 2,
        withClassifiableRound: 2,
        exactlyAtCeiling: 1,
        overCeiling: 1,
        withoutRecordedTier: 0,
        withoutClassifiableRound: 0,
      },
    })
  })
})
