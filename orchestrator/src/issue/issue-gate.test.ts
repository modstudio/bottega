import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { newRecordId } from '../../../shared/record-id.ts'
import { dir } from '../../test/fixtures/store.ts'
import { db } from '../database/db.ts'
import type { RunResult } from '../run/run-types.ts'
import { ISSUE_GATE_WAIT_MS, runIssueGate } from './issue-gate.ts'

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd: root })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

test('issue verification records one passing gate through the worker broker', async () => {
  const main = mkdtempSync(join(dir, 'issue-gate-main-'))
  const root = join(main, '.claude', 'worktrees', 'issue-gate')
  const scratch = mkdtempSync(join(dir, 'issue-gate-scratch-'))
  try {
    git(main, 'init', '-q')
    git(main, 'config', 'user.email', 'fixture@example.com')
    git(main, 'config', 'user.name', 'Fixture')
    git(main, 'commit', '--allow-empty', '-qm', 'fixture')
    git(main, 'worktree', 'add', '-qb', 'DEV-1-fix', root)
    const head = git(root, 'rev-parse', 'HEAD')
    const projectId = (
      db()
        .query(
          'INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?) RETURNING record_id AS id',
        )
        .get(
          newRecordId(),
          'issue-gate-fixture',
          main,
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
        worktree: { path: root, repoRoot: main, branch: 'DEV-1-fix', base: head },
      } as RunResult,
      scratch,
    )
    expect(result.ok).toBe(true)
    expect(result.id).toBeGreaterThan(0)
    expect(
      db().query('SELECT exit_code,head_commit FROM gate_execution WHERE id=?').get(result.id),
    ).toEqual({ exit_code: 0, head_commit: head })
  } finally {
    rmSync(main, { recursive: true, force: true })
    rmSync(scratch, { recursive: true, force: true })
  }
})

test('issue verification bounds an unfinished broker gate and records its cancellation', async () => {
  const main = mkdtempSync(join(dir, 'issue-gate-expiry-main-'))
  const root = join(main, '.claude', 'worktrees', 'issue-gate-expiry')
  git(main, 'init', '-q')
  git(main, 'config', 'user.email', 'fixture@example.com')
  git(main, 'config', 'user.name', 'Fixture')
  git(main, 'commit', '--allow-empty', '-qm', 'fixture')
  git(main, 'worktree', 'add', '-qb', 'DEV-1-fix', root)
  const head = git(root, 'rev-parse', 'HEAD')
  const projectId = (
    db()
      .query(
        'INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?) RETURNING record_id AS id',
      )
      .get(newRecordId(), 'issue-gate-expiry', main, 'bun', JSON.stringify({ gate: 'true' })) as {
      id: string
    }
  ).id
  const run = db()
    .query<{ id: string; number: number }, [string, string, string, string, string, string]>(
      `INSERT INTO run
        (record_id,number,started_at,agent,job,project_record_id,prompt_sha,prompt_bytes,prompt_head,status,worktree,base_commit,worktree_source)
       VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,?,'issue-worker',?,'sha',1,'fixture','ok',?,?,'git')
       RETURNING record_id AS id,number`,
    )
    .get(newRecordId(), new Date().toISOString(), 'codex', projectId, root, head)!
  let closed = false
  const receivedTimeouts: number[] = []
  let environment: Record<string, string> | null = null

  try {
    const result = await runIssueGate(
      {
        record_id: run.id,
        number: run.number,
        worktree: { path: root, repoRoot: main, branch: 'DEV-1-fix', base: head },
      } as RunResult,
      root,
      {
        startBroker: (input) => {
          environment = input.environment
          return {
            close: async () => {
              closed = true
            },
          }
        },
        wait: async (_finished, timeoutMs) => {
          receivedTimeouts.push(timeoutMs)
          return false
        },
      },
    )

    expect(receivedTimeouts).toEqual([ISSUE_GATE_WAIT_MS])
    expect(closed).toBe(true)
    expect(environment).toMatchObject({
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      ORCH_MAIN_CHECKOUT: main,
    })
    expect(result.id).toBeGreaterThan(0)
    expect(result).toMatchObject({
      ok: false,
      fixTreeSafeToRelease: true,
      text: `issue coordinator gate did not finish within ${ISSUE_GATE_WAIT_MS}ms`,
    })
    expect(
      db()
        .query(
          'SELECT exit_code,timed_out,cancelled_reason,finished_at FROM gate_execution WHERE id=?',
        )
        .get(result.id),
    ).toEqual({
      exit_code: -1,
      timed_out: 0,
      cancelled_reason: result.text,
      finished_at: expect.any(String),
    })
  } finally {
    rmSync(main, { recursive: true, force: true })
  }
})

test('issue verification retains the fix tree when an expired gate cannot be reaped', async () => {
  const main = mkdtempSync(join(dir, 'issue-gate-reap-failure-main-'))
  const root = join(main, '.claude', 'worktrees', 'issue-gate-reap-failure')
  try {
    git(main, 'init', '-q')
    git(main, 'config', 'user.email', 'fixture@example.com')
    git(main, 'config', 'user.name', 'Fixture')
    git(main, 'commit', '--allow-empty', '-qm', 'fixture')
    git(main, 'worktree', 'add', '-qb', 'DEV-1-fix', root)
    const head = git(root, 'rev-parse', 'HEAD')
    const projectId = (
      db()
        .query(
          'INSERT INTO project (record_id,name,path,stack,settings) VALUES (?,?,?,?,?) RETURNING record_id AS id',
        )
        .get(
          newRecordId(),
          'issue-gate-reap-failure',
          main,
          'bun',
          JSON.stringify({ gate: 'true' }),
        ) as {
        id: string
      }
    ).id
    const run = db()
      .query<{ id: string; number: number }, [string, string, string, string, string, string]>(
        `INSERT INTO run
          (record_id,number,started_at,agent,job,project_record_id,prompt_sha,prompt_bytes,prompt_head,status,worktree,base_commit,worktree_source)
         VALUES (?,(SELECT COALESCE(MAX(number),0)+1 FROM run),?,?,'issue-worker',?,'sha',1,'fixture','ok',?,?,'git')
         RETURNING record_id AS id,number`,
      )
      .get(newRecordId(), new Date().toISOString(), 'codex', projectId, root, head)!

    const result = await runIssueGate(
      {
        record_id: run.id,
        number: run.number,
        worktree: { path: root, repoRoot: main, branch: 'DEV-1-fix', base: head },
      } as RunResult,
      root,
      {
        startBroker: () => ({
          close: async () => {
            throw new Error('process group survived')
          },
        }),
        wait: async () => false,
      },
    )

    expect(result).toMatchObject({
      ok: false,
      fixTreeSafeToRelease: false,
      text: expect.stringContaining(`gate process could not be reaped for run ${run.id}`),
    })
    expect(
      db()
        .query('SELECT finished_at,cancelled_reason FROM gate_execution WHERE id=?')
        .get(result.id),
    ).toEqual({ finished_at: null, cancelled_reason: null })
  } finally {
    rmSync(main, { recursive: true, force: true })
  }
})
