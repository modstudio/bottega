import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { serializePathSet } from './review-group.ts'
import { measureChangeIdentity, pinRef } from './review-pins.ts'
import {
  fixFilesFromPatches,
  gatherPostFixReviewFacts,
  latestCompletedReview,
  mapPatchPaths,
  type PerPathPatch,
  pathNeutralContentIdentity,
  postFixReviewDecision,
} from './review-post-fix.ts'
import { applicableRoundLensPlan } from './review-round-lens-plan.ts'

const patch = (path: string, patchId: string, insertions = 1, deletions = 0): PerPathPatch => ({
  path,
  patchId,
  insertions,
  deletions,
})

test('a squashed change attributes only the file whose patch changed', () => {
  const reviewed = [patch('src/a.ts', 'a'), patch('src/b.ts', 'b')]
  const current = [patch('src/a.ts', 'a'), patch('src/b.ts', 'b-fixed', 2, 1)]

  expect(fixFilesFromPatches(reviewed, current)).toEqual([
    { path: 'src/b.ts', insertions: 2, deletions: 1 },
  ])
})

test('a file added by the fix is a fix file with current-change counts', () => {
  expect(fixFilesFromPatches([], [patch('src/new.ts', 'new', 4, 0)])).toEqual([
    { path: 'src/new.ts', insertions: 4, deletions: 0 },
  ])
})

test('a file dropped from the change is a fix file with reviewed-change counts', () => {
  expect(fixFilesFromPatches([patch('src/dropped.ts', 'old', 3, 1)], [])).toEqual([
    { path: 'src/dropped.ts', insertions: 3, deletions: 1 },
  ])
})

test('a reviewed path mapped through a trunk rename keeps the same patch', () => {
  const reviewed = mapPatchPaths(
    [patch('critical/reviewed.ts', 'unchanged-patch')],
    new Map([['critical/reviewed.ts', 'critical/renamed.ts']]),
  )

  expect(fixFilesFromPatches(reviewed, [patch('critical/renamed.ts', 'unchanged-patch')])).toEqual(
    [],
  )
})

test('path-neutral content identity preserves whitespace and diff body lines', () => {
  const whitespaceBefore = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+changed
`
  const whitespaceAfter = whitespaceBefore.replace('+changed\n', '+changed \n')
  const commentOne = `diff --git a/query.sql b/query.sql
index 1111111..2222222 100644
--- a/query.sql
+++ b/query.sql
@@ -1 +0,0 @@
--- comment one
`
  const commentTwo = commentOne.replace('comment one', 'comment two')

  expect(pathNeutralContentIdentity(whitespaceBefore)).not.toBe(
    pathNeutralContentIdentity(whitespaceAfter),
  )
  expect(pathNeutralContentIdentity(commentOne)).not.toBe(pathNeutralContentIdentity(commentTwo))
})

test('path-neutral content identity ignores paths and hunk line numbers', () => {
  const first = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+changed
`
  const shiftedAndRenamed = `diff --git a/lib/renamed.ts b/lib/renamed.ts
index aaaaaaa..bbbbbbb 100644
--- a/lib/renamed.ts
+++ b/lib/renamed.ts
@@ -101 +205 @@
-old
+changed
`

  expect(pathNeutralContentIdentity(first)).toBe(pathNeutralContentIdentity(shiftedAndRenamed))
})

test('a mode-only section has a content identity distinct from no change', () => {
  const modeOnly = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
`
  expect(pathNeutralContentIdentity(modeOnly)).not.toBe(pathNeutralContentIdentity(''))
})

test('a failed comparison selects a round from every current changed path', () => {
  const postFix = postFixReviewDecision({
    facts: {
      completed: { number: 1, identity: 'review', launchKey: 'DEV-1644', runIds: [] },
      reviewedTip: 'reviewed',
      fixFiles: [
        { path: 'critical/change.ts', insertions: 2, deletions: 1 },
        { path: 'src/change.ts', insertions: 1, deletions: 0 },
      ],
      comparisonError: 'section count mismatch',
    },
    tier: 3,
    review: {
      lenses: [
        { lens: 'safety', paths: ['critical/**'] },
        { lens: 'craft', paths: ['src/**'] },
      ],
      risk: {
        paths: [{ pattern: '^critical/', tier: 3, reason: 'critical surface' }],
        unlisted: 2,
      },
    },
  })

  expect(postFix).toMatchObject({
    kind: 'comparison-failed',
    error: 'section count mismatch',
    fixPaths: ['critical/change.ts', 'src/change.ts'],
    tierThreePaths: ['critical/change.ts'],
  })
  expect(
    applicableRoundLensPlan({
      relevant: { lenses: ['safety', 'craft'] },
      facts: {
        reviewedPathsByLens: { safety: [], craft: [] },
        completedLenses: ['safety', 'craft'],
        satisfiedSecondOpinionLenses: [],
        latestAcceptedOrModifiedLenses: [],
      },
      postFix,
      fixPathsByLens: {
        safety: ['critical/change.ts'],
        craft: ['src/change.ts'],
      },
    }).round,
  ).toMatchObject({ lenses: ['safety', 'craft'] })
})

const unidentifiedTipFacts = {
  completed: { number: 7, identity: null, launchKey: null, runIds: [] },
  reviewedTip: null,
  fixFiles: null,
}

test('a completed tier-two round needs no later round when its reviewed tip is unidentified', () => {
  expect(
    postFixReviewDecision({ facts: unidentifiedTipFacts, tier: 2, review: undefined }),
  ).toMatchObject({
    kind: 'no-round-needed',
    reviewNumber: 7,
    reviewedTip: null,
    applicability: { lenses: [] },
  })
})

test('a completed tier-three round applies the fallback when its reviewed tip is unidentified', () => {
  expect(
    postFixReviewDecision({ facts: unidentifiedTipFacts, tier: 3, review: undefined }),
  ).toEqual({
    kind: 'reviewed-tip-unidentified',
    reviewNumber: 7,
  })
})

test('only a completed review recorded with the round role establishes a completed round', () => {
  const database = migratedTestDatabase()
  const projectRecordId = newRecordId()
  const runId = newRecordId()
  const reviewRecordId = newRecordId()
  database
    .query(
      "INSERT INTO project (record_id,name,path,settings) VALUES (?,'fixture','/fixture','{}')",
    )
    .run(projectRecordId)
  database
    .query(
      `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,
          repo,project_record_id,branch,launch_key)
       VALUES (?,1,'2026-10-22','codex','review-lens','sha',1,'head','ok',
          'fixture',?,'DEV-1723','DEV-1723')`,
    )
    .run(runId, projectRecordId)
  database
    .query(
      `INSERT INTO review (record_id,number,recorded_at,completed_at,tier,role,patch_id,path_set)
       VALUES (?,2,'2026-10-22T00:00:00Z','2026-10-22T01:00:00Z',2,'supplementary','patch','["a.ts"]')`,
    )
    .run(reviewRecordId)
  database
    .query(
      `INSERT INTO review_lens
         (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,
          commands_run,could_not_verify)
       VALUES (?,?,?,'issue-blast-radius','codex','[]','["a.ts"]','[]','[]')`,
    )
    .run(newRecordId(), reviewRecordId, runId)
  const supplementary = latestCompletedReview(database, 'fixture', 'DEV-1723')
  expect(supplementary).toBeNull()
  expect(
    postFixReviewDecision({
      facts: { completed: null },
      tier: 2,
      review: { lenses: [{ lens: 'correctness' }, { lens: 'craft' }] },
    }),
  ).toEqual({ kind: 'no-completed-round' })

  const roundRunId = newRecordId()
  const roundReviewId = newRecordId()
  database
    .query(
      `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,
          repo,project_record_id,branch,launch_key)
       VALUES (?,2,'2026-10-21','codex','review-lens','sha',1,'head','ok',
          'fixture',?,'DEV-1723','DEV-1723')`,
    )
    .run(roundRunId, projectRecordId)
  database
    .query(
      `INSERT INTO review (record_id,number,recorded_at,completed_at,tier,role,patch_id,path_set)
       VALUES (?,1,'2026-10-21T00:00:00Z','2026-10-21T01:00:00Z',2,'round','patch','["a.ts"]')`,
    )
    .run(roundReviewId)
  database
    .query(
      `INSERT INTO review_lens
         (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,
          commands_run,could_not_verify)
       VALUES (?,?,?,'correctness-reviewer','codex','[]','["a.ts"]','[]','[]')`,
    )
    .run(newRecordId(), roundReviewId, roundRunId)
  expect(latestCompletedReview(database, 'fixture', 'DEV-1723')).toMatchObject({ number: 1 })
  database.close()
})

function git(repo: string, ...args: string[]): string {
  const result = spawnFixtureGitSync(args, { cwd: repo })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

test('identifies an ancestor commit first and falls back to patch identity after a rebase', () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-review-post-fix-key-'))
  const database = migratedTestDatabase()
  try {
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'fixture@example.com')
    git(repo, 'config', 'user.name', 'Fixture')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, 'add', 'base.txt')
    git(repo, 'commit', '-m', 'base')
    const branch = `orch/${crypto.randomUUID()}`
    git(repo, 'checkout', '-b', branch)
    mkdirSync(join(repo, 'src'))
    writeFileSync(join(repo, 'src/app.ts'), 'export const app = true\n')
    git(repo, 'add', 'src/app.ts')
    git(repo, 'commit', '-m', 'reviewed change')
    const reviewed = git(repo, 'rev-parse', 'HEAD')
    const mergeBase = git(repo, 'merge-base', 'main', reviewed)
    const identity = measureChangeIdentity(repo, mergeBase, reviewed)
    if (!identity) throw new Error('reviewed change has no identity')
    const projectRecordId = newRecordId()
    const runId = newRecordId()
    const reviewRecordId = newRecordId()
    database
      .query("INSERT INTO project (record_id,name,path,settings) VALUES (?,'fixture',?,'{}')")
      .run(projectRecordId, repo)
    database
      .query(
        `INSERT INTO run
           (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,
            repo,project_record_id,branch,launch_key,base_commit,input_tree,head_commit)
         VALUES (?,1,'2026-10-22','codex','review-lens','sha',1,'head','ok',
            'fixture',?,?, 'DEV-1598',?,?,?)`,
      )
      .run(runId, projectRecordId, branch, mergeBase, reviewed, reviewed)
    database
      .query(
        `INSERT INTO review (record_id,number,recorded_at,completed_at,tier,patch_id,path_set)
         VALUES (?,1,'2026-10-22T00:00:00Z','2026-10-22T01:00:00Z',2,?,?)`,
      )
      .run(reviewRecordId, 'identity-from-an-earlier-base', serializePathSet(identity.paths))
    database
      .query(
        `INSERT INTO review_lens
           (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,
            commands_run,could_not_verify)
         VALUES (?,?,?,'correctness','codex','[]','["src/app.ts"]','[]','[]')`,
      )
      .run(newRecordId(), reviewRecordId, runId)
    git(repo, 'update-ref', pinRef(runId), reviewed)
    writeFileSync(join(repo, 'src/app.test.ts'), 'export const covered = true\n')
    git(repo, 'add', 'src/app.test.ts')
    git(repo, 'commit', '-m', 'later test-only commit')
    const to = git(repo, 'rev-parse', 'HEAD')
    const facts = gatherPostFixReviewFacts({
      database,
      repo,
      to,
      trunkRef: 'main',
      project: 'fixture',
      branch,
    })
    expect(facts.completed).not.toBeNull()
    expect(facts).toMatchObject({ reviewedTip: reviewed })
    expect(postFixReviewDecision({ facts, tier: 2, review: undefined }).kind).toBe(
      'no-round-needed',
    )
    git(repo, 'checkout', 'main')
    const rebasedBranch = `orch/${crypto.randomUUID()}`
    git(repo, 'checkout', '-b', rebasedBranch)
    writeFileSync(join(repo, 'change.txt'), 'reviewed\n')
    git(repo, 'add', 'change.txt')
    git(repo, 'commit', '-m', 'reviewed change')
    const originalReviewed = git(repo, 'rev-parse', 'HEAD')
    const originalBase = git(repo, 'merge-base', 'main', originalReviewed)
    const rebasedIdentity = measureChangeIdentity(repo, originalBase, originalReviewed)
    if (!rebasedIdentity) throw new Error('reviewed change has no identity')
    const rebasedRunId = newRecordId()
    const rebasedReviewRecordId = newRecordId()
    database
      .query(
        `INSERT INTO run
           (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,
            repo,project_record_id,branch,launch_key,base_commit,input_tree,head_commit)
         VALUES (?,2,'2026-10-22','codex','review-lens','sha',1,'head','ok',
            'fixture',?,?, 'DEV-1598',?,?,?)`,
      )
      .run(
        rebasedRunId,
        projectRecordId,
        rebasedBranch,
        originalBase,
        originalReviewed,
        originalReviewed,
      )
    database
      .query(
        `INSERT INTO review (record_id,number,recorded_at,completed_at,tier,patch_id,path_set)
         VALUES (?,2,'2026-10-22T00:00:00Z','2026-10-22T01:00:00Z',2,?,?)`,
      )
      .run(rebasedReviewRecordId, rebasedIdentity.patchId, serializePathSet(rebasedIdentity.paths))
    database
      .query(
        `INSERT INTO review_lens
           (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,
            commands_run,could_not_verify)
         VALUES (?,?,?,'correctness','codex','[]','["change.txt"]','[]','[]')`,
      )
      .run(newRecordId(), rebasedReviewRecordId, rebasedRunId)
    git(repo, 'update-ref', pinRef(rebasedRunId), originalReviewed)
    git(repo, 'checkout', 'main')
    writeFileSync(join(repo, 'trunk.txt'), 'advanced\n')
    git(repo, 'add', 'trunk.txt')
    git(repo, 'commit', '-m', 'advance trunk')
    git(repo, 'checkout', rebasedBranch)
    git(repo, 'rebase', 'main')
    const rebasedReviewed = git(repo, 'rev-parse', 'HEAD')
    expect(
      spawnFixtureGitSync(['merge-base', '--is-ancestor', originalReviewed, rebasedReviewed], {
        cwd: repo,
      }).exitCode,
    ).not.toBe(0)
    const rebasedFacts = gatherPostFixReviewFacts({
      database,
      repo,
      to: rebasedReviewed,
      trunkRef: 'main',
      project: 'fixture',
      branch: rebasedBranch,
    })
    expect(rebasedFacts).toMatchObject({ reviewedTip: originalReviewed, fixFiles: [] })
    database.query('UPDATE run SET review_ref=? WHERE record_id=?').run(rebasedBranch, rebasedRunId)
    mkdirSync(join(repo, 'critical'))
    writeFileSync(join(repo, 'critical/fix.ts'), 'export const fixed = true\n')
    git(repo, 'add', 'critical/fix.ts')
    git(repo, 'commit', '-m', 'tier three fix')
    const fixedTip = git(repo, 'rev-parse', 'HEAD')
    const fixedFacts = gatherPostFixReviewFacts({
      database,
      repo,
      to: fixedTip,
      trunkRef: 'main',
      project: 'fixture',
      branch: rebasedBranch,
    })
    expect(fixedFacts).toMatchObject({ reviewedTip: originalReviewed })
    expect(
      postFixReviewDecision({
        facts: fixedFacts,
        tier: 3,
        review: {
          lenses: [],
          risk: {
            paths: [{ pattern: '^critical/', tier: 3, reason: 'critical surface' }],
            unlisted: 2,
          },
        },
      }),
    ).toMatchObject({
      kind: 're-lens',
      reviewedTip: originalReviewed,
      tierThreePaths: ['critical/fix.ts'],
    })
  } finally {
    database.close()
    rmSync(repo, { recursive: true, force: true })
  }
})
