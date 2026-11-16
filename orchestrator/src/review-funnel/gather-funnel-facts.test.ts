import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { migratedTestDatabase } from '../database/test-database.fixture.ts'
import type { Project } from '../project/projects.ts'
import { applicableReview } from '../review/review-applicability.ts'
import { measureChangeIdentity, requireChangeIdentity } from '../review/review-pins.ts'
import { gatherFunnelFacts, requireFunnelChangeIdentity } from './gather-funnel-facts.ts'

const repo = resolve(import.meta.dir, '../../..')
const branch = 'DEV-2336-fixture'

test('review-funnel identity refusal includes the failed git command and stderr', () => {
  const fixtureRepo = mkdtempSync(join(tmpdir(), 'orch-funnel-identity-'))
  const fixtureGit = (...args: string[]) => {
    const result = spawnFixtureGitSync(args, { cwd: fixtureRepo })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  try {
    fixtureGit('init', '-b', 'main')
    fixtureGit('config', 'user.email', 'fixture@example.com')
    fixtureGit('config', 'user.name', 'Fixture')
    writeFileSync(join(fixtureRepo, 'app.txt'), 'fixture\n')
    fixtureGit('add', 'app.txt')
    fixtureGit('commit', '-m', 'fixture')

    let message = ''
    try {
      requireFunnelChangeIdentity('DEV-2352-large', () =>
        requireChangeIdentity(fixtureRepo, 'HEAD', 'refs/heads/absent'),
      )
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause)
    }
    expect(message).toContain('could not measure review-funnel change DEV-2352-large:')
    expect(message).toContain('git diff --name-only HEAD..refs/heads/absent failed:')
    expect(message).toContain('fatal:')
  } finally {
    rmSync(fixtureRepo, { recursive: true, force: true })
  }
})

function fixture(landingBranch: string) {
  const database = migratedTestDatabase()
  const projectId = newRecordId()
  const settings = { trunk: 'main', keyPrefixes: ['DEV'], review: { lenses: [] } }
  database
    .query(
      `INSERT INTO project (record_id,name,path,stack,canon,settings)
       VALUES (?,'fixture',?,'typescript',0,?)`,
    )
    .run(projectId, repo, JSON.stringify(settings))

  const reviewIds = ['first', 'second'].map((name, index) => {
    const reviewId = newRecordId()
    const runId = newRecordId()
    database
      .query(
        `INSERT INTO run
         (record_id,number,started_at,agent,job,prompt_sha,prompt_bytes,prompt_head,status,turn,
          project_record_id,repo,branch,launch_key)
         VALUES (?,?,?,'codex','review-lens','sha',1,'head','ok',1,?,'fixture',?,'DEV-2336')`,
      )
      .run(runId, index + 1, `2026-11-15T15:0${index}:00Z`, projectId, branch)
    database
      .query(
        `INSERT INTO review
         (record_id,number,project_record_id,recorded_at,tier,role,patch_id,path_set)
         VALUES (?,?,?, ?,3,'round',?,?)`,
      )
      .run(
        reviewId,
        index + 1,
        projectId,
        `2026-11-15T15:0${index}:00Z`,
        `patch-${name}`,
        JSON.stringify([`${name}.ts`]),
      )
    database
      .query(
        `INSERT INTO review_lens
         (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,
          commands_run,could_not_verify)
         VALUES (?,?,?,'correctness','codex','[]','[]','[]','[]')`,
      )
      .run(newRecordId(), reviewId, runId)
    return reviewId
  })

  const prNumber = 2024
  database
    .query(
      `INSERT INTO landing_triage_snapshot
       (record_id,project,project_record_id,branch,tip,tree,pr_number,review_record_ids,patch_id,
        tier,lens_rounds,finding_count,at)
       VALUES (?,'fixture',?,?,'tip','tree',?,?, 'landing-patch',3,2,0,'2026-11-15T15:05:00Z')`,
    )
    .run(newRecordId(), projectId, landingBranch, prNumber, JSON.stringify(reviewIds))
  database
    .query(
      `INSERT INTO branch_landing_record
       (record_id,project,project_record_id,branch,tip,pr_number,merge_commit,merged_at,recorded_at)
       VALUES (?,'fixture',?,?,'tip',?,'merge','2026-11-15T15:06:00Z','2026-11-15T15:06:00Z')`,
    )
    .run(newRecordId(), projectId, landingBranch, prNumber)

  const project: Project = {
    recordId: projectId,
    name: 'fixture',
    path: repo,
    stack: 'typescript',
    canon: false,
    retiredAt: null,
    settings,
  }
  const identity = measureChangeIdentity(repo, 'HEAD^', 'HEAD')!
  return {
    database,
    facts: gatherFunnelFacts({
      database,
      cwd: repo,
      base: 'HEAD^',
      head: 'HEAD',
      branch,
      project,
      selectionWindow: 50,
      resolved: {
        tier: 3,
        applicability: applicableReview(3, identity.paths, settings.review),
        group: {
          project: project.name,
          branch,
          patchId: identity.patchId,
          zeroContextPatchId: identity.zeroContextPatchId,
          pathSet: identity.paths,
        },
      },
    }),
  }
}

test("a change's own merged landing does not mark its review rounds as previously landed", () => {
  const { database, facts } = fixture(branch)
  try {
    expect(facts.rounds).toHaveLength(2)
    expect(facts.rounds.every(({ landed }) => landed === false)).toBe(true)
  } finally {
    database.close()
  }
})

test("a different branch's merged landing marks inherited review rounds as previously landed", () => {
  const { database, facts } = fixture('DEV-2335-earlier')
  try {
    expect(facts.rounds).toHaveLength(2)
    expect(facts.rounds.every(({ landed }) => landed === true)).toBe(true)
  } finally {
    database.close()
  }
})
