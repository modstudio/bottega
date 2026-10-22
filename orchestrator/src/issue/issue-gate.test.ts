import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { RunResult } from '../run/run-types.ts'
import { runIssueGate } from './issue-gate.ts'

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

test('issue verification records one passing gate through the worker broker', async () => {
  const root = mkdtempSync(join(dir, 'issue-gate-'))
  const scratch = mkdtempSync(join(dir, 'issue-gate-scratch-'))
  try {
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'fixture@example.com')
    git(root, 'config', 'user.name', 'Fixture')
    git(root, 'commit', '--allow-empty', '-qm', 'fixture')
    const head = git(root, 'rev-parse', 'HEAD')
    const projectId = (
      db()
        .query(
          'INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?) RETURNING record_id AS id',
        )
        .get(
          newRecordId(),
          'issue-gate-fixture',
          root,
          'bun',
          JSON.stringify({ gate: 'true' }),
        ) as {
        id: string
      }
    ).id
    const run = db()
      .query<
        { id: string; number: number },
        [string, string, string, string, string, string, string]
      >(
        `INSERT INTO run
          (record_id,number,started_at,agent,job,project_record_id,prompt_sha,prompt_bytes,prompt_head,status,worktree,base_commit,head_commit,worktree_source)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,?,'issue-worker',?,'sha',1,'fixture','ok',?,?,?,'git')
         RETURNING record_id AS id,number`,
      )
      .get(newRecordId(), new Date().toISOString(), 'codex', projectId, root, head, head)!
    const result = await runIssueGate(
      {
        record_id: run.id,
        number: run.number,
        worktree: { path: root, repoRoot: root, branch: 'DEV-1-fix', base: head },
      } as RunResult,
      scratch,
    )
    expect(result.ok).toBe(true)
    expect(result.id).toBeGreaterThan(0)
    expect(
      db().query('SELECT exit_code,head_commit FROM gate_execution WHERE id=?').get(result.id),
    ).toEqual({ exit_code: 0, head_commit: head })
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})
