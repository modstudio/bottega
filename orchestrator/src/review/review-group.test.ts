import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { newRecordId } from '../../../shared/record-id.ts'
import { applyMigrations } from '../database/migrations.ts'
import { decideTriage } from '../pull-request/triage-decision.ts'
import { measureChangeGroup, reviewsForTriage } from './review-group.ts'
import type { ReviewTier } from './review-tier.ts'

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
    .query<{ id: number }, [string]>(
      `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,project_record_id,branch)
       VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-09-25','codex','review-lens','sha',1,'head','ok','fixture',?,'DEV-977')
       RETURNING record_id AS id`,
    )
    .get(projectId)!
  const review = database
    .query<{ id: number }, []>(
      `INSERT INTO review (record_id,recorded_at,completed_at,patch_id,path_set,tier)
       VALUES ('${newRecordId()}','2026-09-25','2026-09-25','stable-patch','["a.ts"]',1) RETURNING id`,
    )
    .get()!
  database
    .query(
      `INSERT INTO review_lens
         (record_id,review_id,run_record_id,lens,agent,model,standards_read,files_covered,commands_run,could_not_verify)
       VALUES ('${newRecordId()}',?,?,'correctness','codex','model','[]','["a.ts"]','[]','[]')`,
    )
    .run(review.id, run.id)
  database.query("UPDATE project SET name='renamed-fixture' WHERE record_id=?").run(projectId)

  expect(
    reviewsForTriage(database, {
      project: 'renamed-fixture',
      branch: 'DEV-977',
      patchId: 'stable-patch',
      pathSet: ['a.ts'],
    }).reviews,
  ).toHaveLength(1)
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
    const run = database
      .query<{ id: number }, [string, string]>(
        `INSERT INTO run
           (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,repo,project_record_id,branch)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-09-25','codex','review-lens','sha',1,'head','ok','fixture',?,?)
         RETURNING record_id AS id`,
      )
      .get(projectId, branch)!
    database
      .query(
        `INSERT INTO review (id,record_id,recorded_at,completed_at,patch_id,path_set,tier)
         VALUES (?,'${newRecordId()}','2026-09-25T00:00:00Z','2026-09-25T01:00:00Z','pre-rebase','["a.ts"]',2)`,
      )
      .run(reviewId)
    database
      .query(
        `INSERT INTO review_lens
           (record_id,review_id,run_record_id,lens,agent,model,standards_read,files_covered,commands_run,could_not_verify)
         VALUES ('${newRecordId()}', ?, ?, ?, 'codex','model','[]','["a.ts"]','[]','[]')`,
      )
      .run(reviewId, run.id, lens)
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
  expect(selected.branchReviews.map((row) => row.reviewId)).toEqual([21, 20])
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
          applicableReview: { lenses: ['correctness', 'craft'] },
        },
      ],
      reads: [
        {
          id: 30,
          tip: 'rebased-tip',
          patchId: 'post-rebase',
          pathSet: '["a.ts"]',
          recordedAt: '2026-09-25T02:00:00Z',
          sessionId: 'owner',
        },
      ],
    }),
  ).toMatchObject({ complete: true, snapshot: { reviewIds: [20, 21] } })
})

test('a moved remote trunk is the shared base for review and admission despite stale local trunk', () => {
  const calls: string[] = []
  const tier: ReviewTier = { tier: 1, risk: 1, size: 0, reasons: ['fixture'] }
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
    tier: () => tier,
  }
  const project = { name: 'fixture', settings: { trunk: 'main' } }
  const reviewed = measureChangeGroup('/fixture', project, 'DEV-977', 'rebased-tip', operations)
  const changed = measureChangeGroup('/fixture', project, 'DEV-977', 'changed-tip', operations)

  expect(calls).toEqual(['rebased-tip:main', 'changed-tip:main'])
  expect(reviewed?.base).toBe('moved-origin-base')
  expect(reviewed?.group.patchId).toBe('reviewed-patch')
  expect(changed?.group.patchId).toBe('changed-patch')
})
