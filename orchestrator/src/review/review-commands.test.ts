import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { Command } from 'commander'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { newRecordId } from '../../../shared/record-id.ts'
import { reviewReply } from '../../test/fixtures/replies.ts'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { addRun, dir } from '../../test/fixtures/store.ts'
import { register as registerReviewCommand } from '../commands/review.ts'
import { db } from '../database/db.ts'
import { setProfile } from '../lens/lenses.ts'
import { upsertProject } from '../project/projects.ts'
import { resolvePullRequestChange } from '../pull-request/pr-admission.ts'
import { serializePathSet } from './review-group.ts'
import { pinRef } from './review-pins.ts'
import { completeReview, recordReview, triageFinding } from './review-triage.ts'

// Deterministic identities produced by importRebasedHistory.
const FIXTURE_BASE = '43942e40f9cf710824da11cd689c453b33cac3d2'
const FIXTURE_WRITER_HEAD = 'afc52b0ea3040a2b0c4a2f75a17bb90821be29c0'

async function runReview(argv: string[], output: string[]): Promise<void> {
  const program = new Command().exitOverride()
  registerReviewCommand(program, {
    log: (...values) => output.push(values.join(' ')),
  })
  await program.parseAsync(['node', 'orch', ...argv])
}

test('unknown review verb with options keeps the review-family refusal', async () => {
  const output: string[] = []

  await expect(runReview(['review', 'bogus', '--json'], output)).rejects.toThrow(
    `unknown: ${PLATFORM_SLUG} review bogus. Try `,
  )
})

test('review record runs through Commander and records the lens output', async () => {
  const output: string[] = []
  const outputPath = join(dir, `review-command-record-${crypto.randomUUID()}.json`)
  try {
    const runId = addRun({ agent: 'codex', job: 'review-lens', lens: 'correctness' })
    writeFileSync(outputPath, JSON.stringify(reviewReply(1, 'high')))
    db().query('UPDATE run SET output_path=? WHERE record_id=?').run(outputPath, runId)

    await runReview(['review', 'record', String(runId)], output)

    expect(output).toEqual([expect.stringMatching(/^recorded review \d+$/)])
    expect(
      db()
        .query<{ count: number }, [string]>(
          'SELECT COUNT(*) AS count FROM review_lens WHERE run_record_id=?',
        )
        .get(runId),
    ).toEqual({ count: 1 })
  } finally {
    rmSync(outputPath, { force: true })
  }
})

test('review triage runs through Commander and updates the finding', async () => {
  const output: string[] = []
  const runId = addRun({ agent: 'codex', job: 'review-lens', lens: 'correctness' })
  const reviewId = recordReview(runId, reviewReply(1, 'high'), db())

  await runReview(
    ['review', 'triage', String(reviewId), '1', 'accepted', '--severity', 'medium'],
    output,
  )

  expect(output).toEqual(['triaged finding 1/1: accepted'])
  expect(
    db()
      .query<{ disposition: string | null; triaged_severity: string | null }, [string]>(
        'SELECT disposition,triaged_severity FROM review_finding WHERE review_record_id=?',
      )
      .get(reviewId),
  ).toEqual({ disposition: 'accepted', triaged_severity: 'medium' })
})

test('review complete runs through Commander and completes a triaged review', async () => {
  const output: string[] = []
  const runId = addRun({ agent: 'codex', job: 'review-lens', lens: 'correctness' })
  const reviewId = recordReview(runId, reviewReply(1, 'high'), db())
  triageFinding(reviewId, 1, 'accepted', undefined, 'high')

  await runReview(['review', 'complete', String(reviewId)], output)

  expect(output).toEqual(['completed review 1'])
  expect(
    db()
      .query<{ completed_at: string | null }, [string]>(
        'SELECT completed_at FROM review WHERE record_id=?',
      )
      .get(reviewId)?.completed_at,
  ).not.toBeNull()
})

test('review amend runs through Commander and records the completed-review amendment', async () => {
  const output: string[] = []
  const runId = addRun({ agent: 'codex', job: 'review-lens', lens: 'correctness' })
  const reviewId = recordReview(runId, reviewReply(1, 'high'), db())
  triageFinding(reviewId, 1, 'accepted', undefined, 'high')
  completeReview(reviewId)

  await runReview(
    [
      'review',
      'amend',
      String(reviewId),
      '1',
      'modified',
      '--severity',
      'medium',
      '--reason',
      'architect correction',
    ],
    output,
  )

  expect(output).toEqual(['amended finding 1/1: modified'])
  expect(
    db()
      .query<{ disposition: string; triaged_severity: string }, [string]>(
        'SELECT disposition,triaged_severity FROM review_finding WHERE review_record_id=?',
      )
      .get(reviewId),
  ).toEqual({ disposition: 'modified', triaged_severity: 'medium' })
})

test('review project-record runs through Commander to the handler refusal', async () => {
  const output: string[] = []
  const unregistered = mkdtempSync(join(tmpdir(), 'orch-review-project-record-'))
  try {
    await expect(
      runReview(
        [
          'review',
          'project-record',
          'DEV-fixture',
          '--cwd',
          unregistered,
          '--reason',
          'record fixture review',
        ],
        output,
      ),
    ).rejects.toThrow(
      `cannot resolve a project for ${unregistered}; pass a registered project worktree`,
    )
  } finally {
    rmSync(unregistered, { recursive: true, force: true })
  }
})

test('review restore-findings runs through Commander in report-only mode', async () => {
  const output: string[] = []

  await runReview(['review', 'restore-findings'], output)

  expect(output).toHaveLength(1)
  expect(output[0]).toContain('mode: report-only')
  expect(output[0]).toContain('rows restored: 0')
})

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: repo,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

test('review tier and admission select the same migration and teardown lenses', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-review-lens-agreement-'))
  const branch = `DEV-1644-${crypto.randomUUID()}`
  try {
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.email', 'fixture@example.com')
    git(repo, 'config', 'user.name', 'Fixture')
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(repo, 'add', 'base.txt')
    git(repo, 'commit', '-m', 'base')
    const base = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/remotes/origin/main', base)
    git(repo, 'checkout', '-b', branch)
    mkdirSync(join(repo, 'database/migrations'), { recursive: true })
    mkdirSync(join(repo, 'orchestrator/src'), { recursive: true })
    writeFileSync(join(repo, 'database/migrations/one.sql'), 'SELECT 1;\n')
    writeFileSync(join(repo, 'orchestrator/src/run-stop.ts'), 'export const stop = true\n')
    git(repo, 'add', 'database/migrations/one.sql', 'orchestrator/src/run-stop.ts')
    git(repo, 'commit', '-m', 'migration and teardown change')
    const name = `lens-agreement-${crypto.randomUUID()}`
    upsertProject({
      recordId: newRecordId(),
      name,
      path: repo,
      settings: {
        trunk: 'main',
        review: {
          lenses: [
            { lens: 'correctness' },
            { lens: 'migration-safety', paths: ['database/migrations/**'] },
            { lens: 'teardown-safety', paths: ['orchestrator/src/run-stop.ts'] },
          ],
          risk: {
            paths: [
              { pattern: '^database/migrations/', tier: 3, reason: 'migration' },
              { pattern: '^orchestrator/src/run-stop\\.ts$', tier: 3, reason: 'teardown' },
            ],
            unlisted: 2,
          },
        },
      },
    })
    const output: string[] = []
    await runReview(['review', 'tier', branch, '--cwd', repo, '--json'], output)
    const tier = JSON.parse(output[0]!) as { lenses: string[] }
    const admission = resolvePullRequestChange(repo)

    expect(tier.lenses).toEqual(['correctness', 'migration-safety', 'teardown-safety'])
    expect(admission.reviewPlan?.round.lenses).toEqual(tier.lenses)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

function seedReviewedPathRename(repo: string, enabled: boolean): string[] {
  if (!enabled) return []
  writeFileSync(join(repo, 'critical/reviewed.ts'), 'branch = false\ncommon\ntrunk = false\n')
  return ['critical/reviewed.ts']
}

function editReviewedPathBeforeRename(repo: string, enabled: boolean): string[] {
  if (!enabled) return []
  writeFileSync(join(repo, 'critical/reviewed.ts'), 'branch = true\ncommon\ntrunk = false\n')
  return ['critical/reviewed.ts']
}

function renameReviewedPathOnTrunk(repo: string, enabled: boolean): string[] {
  if (!enabled) return []
  git(repo, 'mv', 'critical/reviewed.ts', 'critical/renamed.ts')
  writeFileSync(join(repo, 'critical/renamed.ts'), 'branch = false\ncommon\ntrunk = true\n')
  return ['critical/renamed.ts']
}

function importRebasedHistory(repo: string): void {
  const history = `blob
mark :1
data 5
base
commit refs/heads/main
mark :2
author Fixture <fixture@example.com> 0 +0000
committer Fixture <fixture@example.com> 0 +0000
data 4
base
M 100644 :1 base.txt

blob
mark :3
data 13
trunk change
commit refs/remotes/origin/main
mark :4
author Fixture <fixture@example.com> 1 +0000
committer Fixture <fixture@example.com> 1 +0000
data 12
trunk change
from :2
M 100644 :3 orchestrator/hooks/test_session_brief_context.py

blob
mark :5
data 14
writer change
commit refs/heads/DEV-992-fixture
mark :6
author Fixture <fixture@example.com> 2 +0000
committer Fixture <fixture@example.com> 2 +0000
data 13
writer change
from :4
M 100644 :5 notes.md

`
  const result = Bun.spawnSync(['git', 'fast-import'], {
    cwd: repo,
    stdin: new Blob([history]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
}

function postFixFixture(options: {
  fixPath?: string
  fixAfterMerge?: boolean
  resolveConflict?: boolean
  secondOpinion?: boolean
  shiftReviewedPath?: boolean
}): {
  repo: string
  branch: string
  runId: string
  reviewed: string
  mergeTip: string
} {
  const repo = mkdtempSync(join(tmpdir(), 'orch-review-post-fix-'))
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'fixture@example.com')
  git(repo, 'config', 'user.name', 'Fixture')
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  mkdirSync(join(repo, 'critical'))
  mkdirSync(join(repo, 'src'))
  writeFileSync(join(repo, 'critical/shared.ts'), 'export const shared = "base"\n')
  git(
    repo,
    'add',
    'base.txt',
    'critical/shared.ts',
    ...seedReviewedPathRename(repo, options.shiftReviewedPath ?? false),
  )
  git(repo, 'commit', '-m', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  const branch = `DEV-1510-${crypto.randomUUID()}`
  git(repo, 'checkout', '-b', branch)
  writeFileSync(join(repo, 'src/large.ts'), 'export const line = 1\n'.repeat(401))
  if (options.resolveConflict) {
    writeFileSync(join(repo, 'critical/shared.ts'), 'export const shared = "branch"\n')
  }
  git(
    repo,
    'add',
    'src/large.ts',
    ...(options.resolveConflict ? ['critical/shared.ts'] : []),
    ...editReviewedPathBeforeRename(repo, options.shiftReviewedPath ?? false),
  )
  git(repo, 'commit', '-m', 'reviewed change')
  const reviewed = git(repo, 'rev-parse', 'HEAD')
  const name = `post-fix-${crypto.randomUUID()}`
  upsertProject({
    recordId: newRecordId(),
    name,
    path: repo,
    settings: {
      trunk: 'main',
      review: {
        lenses: [
          { lens: 'correctness' },
          { lens: 'safety', paths: ['critical/**'] },
          { lens: 'craft', paths: ['src/**'] },
        ],
        ...(options.secondOpinion ? { secondOpinion: { lens: 'correctness' } } : {}),
        risk: {
          paths: [
            { pattern: '^critical/', tier: 3, reason: 'critical boundary' },
            { pattern: '^src/', tier: 2, reason: 'product source' },
          ],
          unlisted: 2,
        },
      },
    },
  })
  const runId = db()
    .query<{ id: string }, [string, string, string, string, string, string]>(
      `INSERT INTO run
         (record_id,number,started_at,agent,model,lens,job,repo,project_record_id,branch,base_commit,input_tree,head_commit,
          prompt_sha,prompt_bytes,prompt_head,status)
       VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-10-20','codex','fixture-model','correctness','review-lens',?,
               (SELECT record_id FROM project WHERE name=?),?,?,?,?,
               'sha',1,'head','ok')
       RETURNING record_id AS id`,
    )
    .get(name, name, branch, base, reviewed, reviewed)!.id
  const reviewId = recordReview(runId, reviewReply(0), db())
  completeReview(reviewId, db())
  if (options.fixPath && !options.fixAfterMerge) {
    const absoluteFix = join(repo, options.fixPath)
    mkdirSync(join(absoluteFix, '..'), { recursive: true })
    writeFileSync(absoluteFix, 'export const fix = true\n')
    git(repo, 'add', options.fixPath)
    git(repo, 'commit', '-m', 'apply review fix')
  }
  git(repo, 'checkout', 'main')
  if (options.resolveConflict) {
    writeFileSync(join(repo, 'critical/shared.ts'), 'export const shared = "trunk"\n')
  }
  writeFileSync(join(repo, 'critical/trunk.ts'), 'export const trunk = true\n')
  git(
    repo,
    'add',
    'critical/trunk.ts',
    ...(options.resolveConflict ? ['critical/shared.ts'] : []),
    ...renameReviewedPathOnTrunk(repo, options.shiftReviewedPath ?? false),
  )
  git(repo, 'commit', '-m', 'advance trunk')
  git(repo, 'checkout', branch)
  if (options.resolveConflict) {
    const merge = spawnFixtureGitSync(['merge', '--no-edit', 'main'], { cwd: repo })
    expect(merge.exitCode).not.toBe(0)
    writeFileSync(join(repo, 'critical/shared.ts'), 'export const shared = "branch"\n')
    git(repo, 'add', 'critical/shared.ts')
    git(repo, 'commit', '--no-edit')
  } else {
    git(repo, 'merge', '--no-edit', 'main')
  }
  const mergeTip = git(repo, 'rev-parse', 'HEAD')
  if (options.fixPath && options.fixAfterMerge) {
    const absoluteFix = join(repo, options.fixPath)
    mkdirSync(join(absoluteFix, '..'), { recursive: true })
    writeFileSync(absoluteFix, 'export const fix = true\n')
    git(repo, 'add', options.fixPath)
    git(repo, 'commit', '-m', 'apply review fix after trunk merge')
  }
  return { repo, branch, runId, reviewed, mergeTip }
}

test('review tier needs no round when the only post-review commit is a clean trunk merge', async () => {
  const { repo, branch, reviewed } = postFixFixture({ shiftReviewedPath: true })
  try {
    const json: string[] = []
    await runReview(['review', 'tier', branch, '--cwd', repo, '--json'], json)

    expect(JSON.parse(json[0]!).post_fix).toMatchObject({
      kind: 'no-round-needed',
      reviewedTip: reviewed,
      tierThreePaths: [],
    })
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('review tier and admission agree on an owed second opinion', async () => {
  const { repo, branch } = postFixFixture({ secondOpinion: true })
  try {
    const output: string[] = []
    await runReview(['review', 'tier', branch, '--cwd', repo, '--json'], output)
    const tier = JSON.parse(output[0]!) as { lenses: string[]; secondOpinion?: string }
    const admission = resolvePullRequestChange(repo)

    expect(tier.lenses).toEqual([])
    expect(tier.secondOpinion).toBe('correctness')
    expect(admission.reviewPlan?.round.secondOpinion).toBe(tier.secondOpinion)
    expect(admission.reviewPlan?.admissionRequired.secondOpinion).toBe(tier.secondOpinion)

    const human: string[] = []
    await runReview(['review', 'tier', branch, '--cwd', repo], human)
    expect(human.some((line) => line.startsWith('second opinion correctness'))).toBeTrue()
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('review tier needs no round for a never-completed lens when no scoped fix path was touched', async () => {
  const { repo, branch, reviewed } = postFixFixture({ fixPath: 'src/fix.ts' })
  try {
    const output: string[] = []
    await runReview(['review', 'tier', branch, '--cwd', repo], output)

    expect(output).toContain('no round needed: the architect reads the fix and lands it')
    expect(output.some((line) => line.startsWith('lens correctness'))).toBeFalse()
    expect(output.some((line) => line.startsWith('lens craft'))).toBeFalse()

    const json: string[] = []
    await runReview(['review', 'tier', branch, '--cwd', repo, '--json'], json)
    expect(JSON.parse(json[0]!).post_fix).toMatchObject({
      kind: 'no-round-needed',
      reviewedTip: reviewed,
      tierThreePaths: [],
    })
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('review tier re-lenses a tier-three branch commit after a trunk merge', async () => {
  const { repo, branch, reviewed } = postFixFixture({
    fixPath: 'critical/fix.ts',
    fixAfterMerge: true,
  })
  try {
    const output: string[] = []
    await runReview(['review', 'tier', branch, '--cwd', repo], output)

    expect(output.some((line) => line.includes('tier-3 paths touched since review'))).toBeTrue()
    expect(output.some((line) => line.includes('critical/fix.ts'))).toBeTrue()
    expect(output.some((line) => line.startsWith('lens correctness'))).toBeFalse()
    expect(output.some((line) => line.startsWith('lens safety'))).toBeTrue()
    expect(output.some((line) => line.startsWith('lens craft'))).toBeFalse()

    const json: string[] = []
    await runReview(['review', 'tier', branch, '--cwd', repo, '--json'], json)
    expect(JSON.parse(json[0]!).post_fix).toMatchObject({
      kind: 're-lens',
      reviewedTip: reviewed,
      tierThreePaths: ['critical/fix.ts'],
    })
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('review tier re-lenses a conflict resolution in a trunk merge', async () => {
  const { repo, branch, reviewed } = postFixFixture({ resolveConflict: true })
  try {
    const json: string[] = []
    await runReview(['review', 'tier', branch, '--cwd', repo, '--json'], json)

    expect(JSON.parse(json[0]!).post_fix).toMatchObject({
      kind: 're-lens',
      reviewedTip: reviewed,
      tierThreePaths: ['critical/shared.ts'],
    })
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('review tier falls back to patch identity when the reviewed commit pin is absent', async () => {
  const { repo, branch, runId, reviewed } = postFixFixture({ fixPath: 'src/fix.ts' })
  try {
    git(repo, 'update-ref', '-d', pinRef(runId))
    const json: string[] = []
    await runReview(['review', 'tier', branch, '--cwd', repo, '--json'], json)

    expect(JSON.parse(json[0]!).post_fix).toMatchObject({
      kind: 'no-round-needed',
      reviewedTip: reviewed,
      tierThreePaths: [],
    })
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('a rebased writer run tier excludes files changed only on trunk', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-review-tier-'))
  try {
    git(repo, 'init', '-b', 'main')
    importRebasedHistory(repo)

    upsertProject({
      recordId: newRecordId(),
      name: 'tier-fixture',
      path: repo,
      settings: { trunk: 'main' },
    })
    // Deterministic fast-import identity for the fixture's trunk-to-writer range.
    // The command measures the live range, so this assertion fails if they diverge.
    const currentIdentity = {
      patchId: '344d5a66fb0f57fb36bc50cb2108a9046933150d',
      paths: ['notes.md'],
    }
    const run = db()
      .query<{ id: string }, [string, string, string]>(
        `INSERT INTO run
           (record_id,number,started_at,agent,job,repo,project_record_id,branch,base_commit,input_tree,head_commit,
            prompt_sha,prompt_bytes,prompt_head,status)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-09-27','codex','implement','tier-fixture',
                 (SELECT record_id FROM project WHERE name='tier-fixture'),'DEV-992-fixture',?,?,?,
                 'sha',1,'head','ok')
         RETURNING record_id AS id`,
      )
      .get(FIXTURE_BASE, FIXTURE_BASE, FIXTURE_WRITER_HEAD)!
    const output: string[] = []

    const review = db()
      .query<{ record_id: string }, [string, string]>(
        `INSERT INTO review (record_id,number,recorded_at,tier,patch_id,path_set)
         VALUES ('${newRecordId()}',1,'2026-09-28',0,?,?) RETURNING record_id`,
      )
      .get(currentIdentity.patchId, serializePathSet(currentIdentity.paths))!
    db()
      .query(
        `INSERT INTO review_lens
         (record_id,review_record_id,run_record_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
         VALUES ('${newRecordId()}',?,?,'correctness','codex','[]','[]','[]','[]')`,
      )
      .run(review.record_id, run.id)

    await runReview(
      ['review', 'tier', 'DEV-992-fixture', '--cwd', relative(process.cwd(), repo)],
      output,
    )

    expect(output).toContain('tier 0')
    expect(output).toContain('risk 0')
    expect(output).toContain('size 0')
    expect(output).toContain('rounds 1/0')
    expect(output).toContain('current change is already a counted round; no new round consumed')
    expect(output).not.toContain('current change would start a new round')
    expect(output).not.toContain('a new round would exceed the ceiling; stop and ask the operator')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})

test('review tier run target uses the landing merge-base instead of its recorded base', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-review-tier-profiles-'))
  try {
    git(repo, 'init', '-b', 'main')
    importRebasedHistory(repo)
    upsertProject({
      recordId: newRecordId(),
      name: 'tier-profile-fixture',
      path: repo,
      stack: 'bun',
      settings: {
        trunk: 'main',
        review: {
          lenses: [{ lens: 'correctness', basis: 'yield evidence' }, { lens: 'craft' }],
          secondOpinion: { lens: 'correctness', basis: 'escaped defect evidence' },
          risk: {
            paths: [
              {
                pattern: '^orchestrator/hooks/',
                tier: 3,
                reason: 'recorded-base-only hook',
                basis: 'stale recorded base evidence',
              },
              {
                pattern: '^notes\\.md$',
                tier: 3,
                reason: 'reviewed source',
                basis: 'reviewed source evidence',
              },
            ],
            unlisted: 2,
          },
        },
      },
    })
    await setProfile({
      lensId: 'correctness',
      axis: 'framework',
      name: 'bun',
      body: '{"framework_guidance":"Bun guidance.","commands":"bun test"}',
      enabled: true,
      reason: 'review tier stack source fixture',
    })
    const run = db()
      .query<{ id: string }, [string, string, string]>(
        `INSERT INTO run
           (record_id,number,started_at,agent,job,repo,base_commit,input_tree,head_commit,
            prompt_sha,prompt_bytes,prompt_head,status)
         VALUES ('${newRecordId()}',(SELECT COALESCE(MAX(number),0)+1 FROM run),'2026-09-27','codex','review-lens','tier-profile-fixture',?,?,?,
                 'sha',1,'head','ok')
         RETURNING record_id AS id`,
      )
      .get(FIXTURE_BASE, FIXTURE_WRITER_HEAD, FIXTURE_WRITER_HEAD)!
    const output: string[] = []

    await runReview(['review', 'tier', String(run.id)], output)

    expect(FIXTURE_BASE).not.toBe(git(repo, 'merge-base', FIXTURE_WRITER_HEAD, 'origin/main'))
    expect(output).toContain('tier 3')
    expect(output).toContain('risk 3')
    expect(output.some((line) => line.includes('recorded-base-only hook'))).toBeFalse()
    expect(output).toContain('risk map project declaration')
    expect(
      output.some(
        (line) => line.includes('risk 3:') && line.includes('basis: reviewed source evidence'),
      ),
    ).toBeTrue()
    expect(output).toContain('lens correctness  basis: yield evidence  framework=stack')
    expect(output).toContain('lens craft  framework=generic')
    expect(output).toContain(
      'second opinion correctness  basis: escaped defect evidence: dispatch this lens a second time on a different model with --distinct-from <the first run of correctness on this tip>',
    )
    expect(output).toContain('rounds 0/3')
    expect(output).toContain('current change would start a new round')
    const json: string[] = []
    await runReview(['review', 'tier', String(run.id), '--json'], json)
    expect(JSON.parse(json[0]!).riskBasis).toBe('reviewed source evidence')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
