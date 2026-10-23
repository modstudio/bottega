import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import { serializePathSet } from './review-group.ts'
import { measureChangeIdentity, pinRef } from './review-pins.ts'
import { gatherPostFixReviewFacts, postFixReviewDecision } from './review-post-fix.ts'

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
            repo,project_record_id,branch,base_commit,input_tree,head_commit)
         VALUES (?,2,'2026-10-22','codex','review-lens','sha',1,'head','ok',
            'fixture',?,?,?,?,?)`,
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
    expect(rebasedFacts).toMatchObject({ reviewedTip: rebasedReviewed })
    git(repo, 'update-ref', pinRef(rebasedRunId), rebasedReviewed)
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
    expect(fixedFacts).toMatchObject({ reviewedTip: rebasedReviewed })
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
      reviewedTip: rebasedReviewed,
      tierThreePaths: ['critical/fix.ts'],
    })
  } finally {
    database.close()
    rmSync(repo, { recursive: true, force: true })
  }
})
