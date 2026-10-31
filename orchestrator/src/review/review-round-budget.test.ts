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
      atCeiling: roundsUsed >= tier,
      startsNewRound: !currentChangeCounted,
      wouldExceedCeiling,
    })
  })

  test('does not start a round when review policy says no round is needed', () => {
    expect(
      reviewRoundBudgetDecision({
        tier: 3,
        roundsUsed: 1,
        currentChangeCounted: false,
        roundNeeded: false,
      }),
    ).toEqual({
      roundsUsed: 1,
      ceiling: 3,
      currentChangeCounted: false,
      atCeiling: false,
      startsNewRound: false,
      wouldExceedCeiling: false,
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
  lens?: string
  role?: 'round' | 'supplementary'
}): void {
  const project = input.project ?? 'fixture'
  db()
    .query("INSERT OR IGNORE INTO project (record_id,name,path,settings) VALUES (?,?,?,'{}')")
    .run(newRecordId(), project, `/fixture/${project}`)
  const review = db()
    .query<
      { record_id: string },
      [string, string, number | null, 'round' | 'supplementary', string | null, string]
    >(
      `INSERT INTO review (record_id,number,recorded_at,tier,role,patch_id,path_set)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM review),?,?,?,?,?) RETURNING record_id`,
    )
    .get(
      newRecordId(),
      input.at,
      input.tier,
      input.role ?? 'round',
      input.patch,
      JSON.stringify([input.path ?? 'change.ts']),
    )!
  const run = addRun({
    agent: 'codex',
    job: 'review-lens',
    lens: 'correctness',
    probe: input.probe ? 1 : 0,
    startedAt: input.at,
    repo: project,
  })
  db()
    .query(
      'UPDATE run SET branch=?,launch_key=?,project_record_id=(SELECT record_id FROM project WHERE name=?) WHERE record_id=?',
    )
    .run(input.branch, input.launchKey === undefined ? 'DEV-1256' : input.launchKey, project, run)
  if (input.excluded)
    db().query("UPDATE run SET evidence_excluded='void' WHERE record_id=?").run(run)
  if (input.deliveryNone) score(run, 'none')
  db()
    .query(
      `INSERT INTO review_lens
       (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
       VALUES (?,?,?,?,'codex','[]','[]','[]','[]')`,
    )
    .run(newRecordId(), review.record_id, run, input.lens ?? 'correctness')
}

function addMintFact(input: {
  branch: string
  base: string
  project?: string
  launchKey?: string
}): void {
  const project = input.project ?? 'fixture'
  const run = addRun({ agent: 'codex', job: 'implement', repo: project })
  db()
    .query(
      `UPDATE run
          SET branch=?,minted_branch=?,launch_base=?,launch_key=?,
              project_record_id=(SELECT record_id FROM project WHERE name=?)
        WHERE record_id=?`,
    )
    .run(input.branch, input.branch, input.base, input.launchKey ?? 'DEV-1256', project, run)
}

describe('review budget query', () => {
  test('a supplementary result does not consume a review round', () => {
    addEvidence({
      branch: 'DEV-1723',
      at: '2026-10-01T00:00:00Z',
      patch: 'supplementary',
      tier: 2,
      lens: 'issue-blast-radius',
      role: 'supplementary',
    })
    expect(reviewBudgetForBranch(db(), 'fixture', 'DEV-1723', null).roundsUsed).toBe(0)

    addEvidence({
      branch: 'DEV-1723',
      at: '2026-10-02T00:00:00Z',
      patch: 'declared',
      tier: 2,
      lens: 'correctness',
    })
    expect(reviewBudgetForBranch(db(), 'fixture', 'DEV-1723', null).roundsUsed).toBe(1)
  })

  test('a blast-radius lens on a round-role review consumes a round', () => {
    addEvidence({
      branch: 'DEV-1723-legacy',
      at: '2026-10-01T00:00:00Z',
      patch: 'legacy',
      tier: 1,
      lens: 'issue-blast-radius',
      role: 'round',
    })
    expect(reviewBudgetForBranch(db(), 'fixture', 'DEV-1723-legacy', null).roundsUsed).toBe(1)
  })

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

  test('reports ancestor and descendant rounds as one lineage unit', () => {
    addEvidence({
      branch: 'DEV-1256-a',
      at: '2026-10-01T00:00:00Z',
      patch: 'one',
      tier: 1,
    })
    addEvidence({
      branch: 'DEV-1256-b',
      at: '2026-10-02T00:00:00Z',
      patch: 'two',
      tier: 1,
    })
    addMintFact({ branch: 'DEV-1256-a', base: 'main' })
    addMintFact({ branch: 'DEV-1256-b', base: 'DEV-1256-a' })

    expect(reviewBudgetReport(db())).toMatchObject({
      branches: [
        {
          project: 'fixture',
          branch: 'DEV-1256-a',
          rounds: 2,
          tier: 1,
        },
      ],
      denominators: {
        eligibleReviewBranches: 1,
        withRecordedTier: 1,
        withClassifiableRound: 1,
        exactlyAtCeiling: 0,
        overCeiling: 1,
        withoutRecordedTier: 0,
        withoutClassifiableRound: 0,
      },
    })
    expect(reviewBudgetForBranch(db(), 'fixture', 'DEV-1256-b', null).roundsUsed).toBe(2)
  })
})
