import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../database/db.ts'
import { upsertProject } from '../project/projects.ts'
import { reviewCommand } from './review-commands.ts'

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
    const run = db()
      .query<{ id: number }, [string, string, string]>(
        `INSERT INTO run
           (started_at,agent,job,repo,branch,base_commit,input_tree,head_commit,
            prompt_sha,prompt_bytes,prompt_head,status)
         VALUES ('2026-09-27','codex','implement','tier-fixture','DEV-992-fixture',?,?,?,
                 'sha',1,'head','ok')
         RETURNING id`,
      )
      .get(staleBase, staleBase, git(repo, 'rev-parse', 'DEV-992-fixture'))!
    const output: string[] = []

    await reviewCommand(
      'tier',
      ['review', 'tier', String(run.id), '--json'],
      { has: (name) => name === 'json', flag: () => undefined },
      {
        log: (...values) => output.push(values.join(' ')),
        usage: () => {
          throw new Error('unexpected usage')
        },
      },
    )

    expect(JSON.parse(output.join('\n'))).toMatchObject({ tier: 0, risk: 0, size: 0 })
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
