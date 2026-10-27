import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from '../database/migrations.ts'
import { decideTriage } from '../pull-request/triage-decision.ts'
import type { ReviewPlan } from './review-applicability.ts'
import {
  measureChangeGroup,
  reviewLensGraded,
  reviewRoundTriageComplete,
  reviewsForTriage,
  type TriageReviewRow,
} from './review-group.ts'
import { reviewBudgetForBranch, reviewRoundBudgetDecision } from './review-round-budget.ts'
import type { ReviewTier } from './review-tier-classifier.ts'

test('a review lens is graded by delivery or all four review grades', () => {
  const noGrades = { reproduced: null, coverage: null, limits: null, overlap: null }

  expect(reviewLensGraded({ delivery: 'none', ...noGrades })).toBe(true)
  expect(reviewLensGraded({ delivery: null, ...noGrades })).toBe(false)
  expect(reviewLensGraded({ delivery: 'full', ...noGrades })).toBe(false)
  expect(
    reviewLensGraded({
      delivery: 'full',
      reproduced: 'all',
      coverage: 'adequate',
      limits: 'named',
      overlap: 'unique',
    }),
  ).toBe(true)
})

test('a round with one graded review and one delivery-none review is triage complete', () => {
  const grades = { reproduced: null, coverage: null, limits: null, overlap: null }
  const review: TriageReviewRow = {
    reviewRecordId: 'review-record',
    reviewNumber: 1,
    recordedAt: '2026-10-27T00:00:00Z',
    completedAt: null,
    tier: 1,
    role: 'round',
    patchId: 'patch',
    pathSet: '["change.ts"]',
    lensIdentities: ['correctness', 'craft'],
    lenses: [
      {
        recordId: 'graded',
        graded: reviewLensGraded({
          delivery: 'full',
          ...grades,
          reproduced: 'all',
          coverage: 'adequate',
          limits: 'named',
          overlap: 'unique',
        }),
      },
      { recordId: 'none', graded: reviewLensGraded({ delivery: 'none', ...grades }) },
    ],
    findings: [],
  }

  expect(reviewRoundTriageComplete(review)).toBe(true)
})

test('change-group lookup carries the same patch after rebase and rejects a different patch', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  const projectId = newRecordId()
  database
    .query(
      "INSERT INTO project (record_id,name,path,settings) VALUES (?,'fixture','/fixture','{}')",
    )
    .run(projectId)
  const run = database
    .query<{ record_id: string }, [string]>(
      `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,project_record_id,branch)
       VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-09-25','codex','review-lens','sha',1,'head','ok','fixture',?,'DEV-977')
       RETURNING record_id`,
    )
    .get(projectId)!
  const review = database
    .query<{ record_id: string }, []>(
      `INSERT INTO review (record_id,number,recorded_at,completed_at,patch_id,path_set,tier)
       VALUES ('${newRecordId()}',1,'2026-09-25','2026-09-25','stable-patch','["a.ts"]',1) RETURNING record_id`,
    )
    .get()!
  database
    .query(
      `INSERT INTO review_lens
         (record_id,review_record_id,run_record_id,lens,agent,model,standards_read,files_covered,commands_run,could_not_verify)
       VALUES ('${newRecordId()}',?,?,'correctness','codex','model','[]','["a.ts"]','[]','[]')`,
    )
    .run(review.record_id, run.record_id)
  database
    .query(
      `INSERT INTO score (record_id,run_record_id,delivery,quality,scored_at)
       VALUES (?,?, 'none',NULL,'2026-09-25')`,
    )
    .run(newRecordId(), run.record_id)
  database.query("UPDATE project SET name='renamed-fixture' WHERE record_id=?").run(projectId)

  const matched = reviewsForTriage(database, {
    project: 'renamed-fixture',
    branch: 'DEV-977',
    patchId: 'stable-patch',
    pathSet: ['a.ts'],
  }).reviews
  expect(matched).toHaveLength(1)
  expect(matched[0]?.lenses[0]?.graded).toBe(true)
  expect(
    reviewsForTriage(database, {
      project: 'renamed-fixture',
      branch: 'DEV-977',
      patchId: 'changed-patch',
      pathSet: ['a.ts'],
    }).reviews,
  ).toEqual([])
})

test('a rebase credits the complete round from the same branch and never another branch', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  const projectId = newRecordId()
  database
    .query(
      "INSERT INTO project (record_id,name,path,settings) VALUES (?,'fixture','/fixture','{}')",
    )
    .run(projectId)
  const addReview = (branch: string, reviewId: number, lens: string) => {
    const reviewRecordId = newRecordId()
    const run = database
      .query<{ record_id: string }, [string, string]>(
        `INSERT INTO run
           (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,project_record_id,branch)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-09-25','codex','review-lens','sha',1,'head','ok','fixture',?,?)
         RETURNING record_id`,
      )
      .get(projectId, branch)!
    database
      .query(
        `INSERT INTO review (number,record_id,recorded_at,completed_at,patch_id,path_set,tier)
         VALUES (?,?,'2026-09-25T00:00:00Z','2026-09-25T01:00:00Z','pre-rebase','["a.ts"]',2)`,
      )
      .run(reviewId, reviewRecordId)
    database
      .query(
        `INSERT INTO review_lens
           (record_id,review_record_id,run_record_id,lens,agent,model,standards_read,files_covered,commands_run,could_not_verify)
         VALUES ('${newRecordId()}', ?, ?, ?, 'codex','model','[]','["a.ts"]','[]','[]')`,
      )
      .run(reviewRecordId, run.record_id, lens)
  }
  addReview('DEV-977', 20, 'correctness')
  addReview('DEV-977', 21, 'craft')
  addReview('DEV-other', 22, 'foreign')

  const selected = reviewsForTriage(database, {
    project: 'fixture',
    branch: 'DEV-977',
    patchId: 'post-rebase',
    pathSet: ['a.ts'],
  })
  expect(selected.reviews).toEqual([])
  expect(selected.branchReviews.map((row) => row.reviewNumber)).toEqual([21, 20])
  expect(
    decideTriage({
      patchId: 'post-rebase',
      pathSet: '["a.ts"]',
      tip: 'rebased-tip',
      tier: 2,
      applicableReview: { lenses: ['correctness', 'craft'] },
      branchOwnerSession: 'owner',
      reviews: selected.reviews,
      branchReviewGroups: [
        {
          reviews: selected.branchReviews,
        },
      ],
      reads: [
        {
          recordId: 'read-30',
          tip: 'rebased-tip',
          patchId: 'post-rebase',
          pathSet: '["a.ts"]',
          recordedAt: '2026-09-25T02:00:00Z',
          sessionId: 'owner',
        },
      ],
    }),
  ).toMatchObject({
    complete: true,
    snapshot: {
      reviewRecordIds: selected.branchReviews.map((row) => row.reviewRecordId).sort(),
    },
  })
})

test('a fix branch inherits its parent review and starts at round two', () => {
  const database = new Database(':memory:')
  applyMigrations(database)
  const projectId = newRecordId()
  database
    .query(
      "INSERT INTO project (record_id,name,path,settings) VALUES (?,'fixture','/fixture','{}')",
    )
    .run(projectId)
  const addRun = (columns: { branch?: string; minted?: string; base?: string }) =>
    database
      .query<{ record_id: string }, [string, string | null, string | null, string | null]>(
        `INSERT INTO run
           (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,
            project_record_id,branch,minted_branch,launch_base,launch_key)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-09-25',
                 'codex','review-lens','sha',1,'head','ok','fixture',?,?,?,?, 'DEV-1686')
         RETURNING record_id`,
      )
      .get(projectId, columns.branch ?? null, columns.minted ?? null, columns.base ?? null)!
  addRun({ minted: 'branch-a', base: 'main' })
  addRun({ minted: 'branch-b', base: 'branch-a' })
  const lensRun = addRun({ branch: 'branch-a' })
  const reviewId = newRecordId()
  database
    .query(
      `INSERT INTO review (record_id,number,recorded_at,completed_at,patch_id,path_set,tier)
       VALUES (?,1,'2026-09-25','2026-09-25','reviewed-patch','["a.ts"]',3)`,
    )
    .run(reviewId)
  database
    .query(
      `INSERT INTO review_lens
         (record_id,review_record_id,run_record_id,lens,agent,model,standards_read,files_covered,
          commands_run,could_not_verify,reproduced,coverage,limits,overlap)
       VALUES (?,?,?,'correctness','codex','model','[]','["a.ts"]','[]','[]',
               'all','adequate','named','unique')`,
    )
    .run(newRecordId(), reviewId, lensRun.record_id)

  const inherited = reviewsForTriage(database, {
    project: 'fixture',
    branch: 'branch-b',
    patchId: 'fixed-patch',
    pathSet: ['a.ts'],
  })
  expect(inherited.branchReviews.map(({ reviewNumber }) => reviewNumber)).toEqual([1])

  const budget = reviewBudgetForBranch(database, 'fixture', 'branch-b', null)
  expect(budget.roundsUsed).toBe(1)
  expect(reviewRoundBudgetDecision({ tier: 3, ...budget, roundNeeded: true })).toMatchObject({
    roundsUsed: 1,
    startsNewRound: true,
  })
})

test('a moved remote trunk is the shared base for review and admission despite stale local trunk', () => {
  const calls: string[] = []
  const tier: ReviewTier = { tier: 1, risk: 1, size: 0, reasons: ['fixture'], riskBasis: null }
  const plan: ReviewPlan = { tier, applicability: { lenses: ['correctness'] } }
  const operations = {
    mergeBase: (_cwd: string, tip: string, trunk: string) => {
      calls.push(`${tip}:${trunk}`)
      return 'moved-origin-base'
    },
    identity: (_cwd: string, base: string, tip: string) => ({
      patchId: tip === 'rebased-tip' ? 'reviewed-patch' : 'changed-patch',
      paths: ['src/change.ts'],
      message: `${base}:${tip}`,
    }),
    reviewPlan: () => plan,
  }
  const project = { name: 'fixture', settings: { trunk: 'main' } }
  const reviewed = measureChangeGroup('/fixture', project, 'DEV-977', 'rebased-tip', operations)
  const changed = measureChangeGroup('/fixture', project, 'DEV-977', 'changed-tip', operations)

  expect(calls).toEqual(['rebased-tip:main', 'changed-tip:main'])
  expect(reviewed?.base).toBe('moved-origin-base')
  expect(reviewed?.group.patchId).toBe('reviewed-patch')
  expect(reviewed?.applicability.lenses).toEqual(['correctness'])
  expect(changed?.group.patchId).toBe('changed-patch')
})
