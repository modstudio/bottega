import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../database/db.ts'
import { setProfile } from '../lens/lenses.ts'
import { upsertProject } from '../project/projects.ts'
import { reviewCommand } from './review-commands.ts'
import { serializePathSet } from './review-group.ts'
import { measureChangeIdentity } from './review-pins.ts'

function git(repo: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: repo,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
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

test('a rebased writer run tier excludes files changed only on trunk', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-review-tier-'))
  try {
    git(repo, 'init', '-b', 'main')
    importRebasedHistory(repo)
    const staleBase = git(repo, 'rev-parse', 'HEAD')

    upsertProject({ name: 'tier-fixture', path: repo, settings: { trunk: 'main' } })
    const currentBase = git(repo, 'rev-parse', 'refs/remotes/origin/main')
    const writerHead = git(repo, 'rev-parse', 'DEV-992-fixture')
    const currentIdentity = measureChangeIdentity(repo, currentBase, writerHead)!
    const run = db()
      .query<{ id: number }, [string, string, string]>(
        `INSERT INTO run
           (started_at,agent,job,repo,branch,base_commit,input_tree,head_commit,
            prompt_sha,prompt_bytes,prompt_head,status)
         VALUES ('2026-09-27','codex','implement','tier-fixture','DEV-992-fixture',?,?,?,
                 'sha',1,'head','ok')
         RETURNING id`,
      )
      .get(staleBase, staleBase, writerHead)!
    const output: string[] = []

    const review = db()
      .query<{ id: number }, [string, string]>(
        `INSERT INTO review (recorded_at,tier,patch_id,path_set)
         VALUES ('2026-09-28',0,?,?) RETURNING id`,
      )
      .get(currentIdentity.patchId, serializePathSet(currentIdentity.paths))!
    db()
      .query(
        `INSERT INTO review_lens
         (review_id,run_id,lens,agent,standards_read,files_covered,commands_run,could_not_verify)
         VALUES (?,?,'correctness','codex','[]','[]','[]','[]')`,
      )
      .run(review.id, run.id)

    await reviewCommand(
      'tier',
      ['review', 'tier', String(run.id)],
      { has: () => false, flag: () => undefined },
      {
        log: (...values) => output.push(values.join(' ')),
        usage: () => {
          throw new Error('unexpected usage')
        },
      },
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

test('review tier reports stack and generic profile sources resolved for its project', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-review-tier-profiles-'))
  try {
    git(repo, 'init', '-b', 'main')
    importRebasedHistory(repo)
    upsertProject({
      name: 'tier-profile-fixture',
      path: repo,
      stack: 'bun',
      settings: {
        trunk: 'main',
        review: { lenses: [{ lens: 'correctness' }, { lens: 'craft' }] },
      },
    })
    setProfile({
      lensId: 'correctness',
      axis: 'framework',
      name: 'bun',
      body: '{"framework_guidance":"Bun guidance.","commands":"bun test"}',
      enabled: true,
      reason: 'review tier stack source fixture',
    })
    const base = git(repo, 'rev-parse', 'main')
    const reviewed = git(repo, 'rev-parse', 'DEV-992-fixture')
    const run = db()
      .query<{ id: number }, [string, string, string]>(
        `INSERT INTO run
           (started_at,agent,job,repo,base_commit,input_tree,head_commit,
            prompt_sha,prompt_bytes,prompt_head,status)
         VALUES ('2026-09-27','codex','review-lens','tier-profile-fixture',?,?,?,
                 'sha',1,'head','ok')
         RETURNING id`,
      )
      .get(base, reviewed, reviewed)!
    const output: string[] = []

    await reviewCommand(
      'tier',
      ['review', 'tier', String(run.id)],
      { has: () => false, flag: () => undefined },
      {
        log: (...values) => output.push(values.join(' ')),
        usage: () => {
          throw new Error('unexpected usage')
        },
      },
    )

    expect(output).toContain('lens correctness  framework=stack')
    expect(output).toContain('lens craft  framework=generic')
    expect(output).toContain('rounds 0/3')
    expect(output).toContain('current change would start a new round')
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
