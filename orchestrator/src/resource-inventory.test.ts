import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addRun, databasesFromNames, hermeticGitEnv, installTestDatabaseInventory,
  parseRefGuardRunId, parseRetainedRef, parseWorktreeDatabaseName, pidRecordIdentity,
  reapStale, reapTestProcess,
  refGuardInventory, retainedRefInventory, terminalProcessAliveConditions,
  upsertProject, worktreeDatabaseConditions, worktreeDatabaseInventory, db,
} from '../test/fixture.ts'
import { pidAlive } from './db.ts'
import { sampleProcesses } from './idle-kill.ts'

afterEach(() => { installTestDatabaseInventory(null) })

test('recipe database names parse only the _wt_<runId> suffix', () => {
  expect(parseWorktreeDatabaseName('star_ship_wt_42')).toBe(42)
  expect(parseWorktreeDatabaseName('app_wt_7')).toBe(7)
  expect(parseWorktreeDatabaseName('postgres')).toBeNull()
  expect(parseWorktreeDatabaseName('wt_3')).toBeNull()
})

test('retained refs and guard directory names parse the run id', () => {
  expect(parseRetainedRef('refs/orch/retained/9')).toBe(9)
  expect(parseRetainedRef('refs/heads/main')).toBeNull()
  expect(parseRefGuardRunId('12')).toBe(12)
  expect(parseRefGuardRunId('.orch-hooks-12')).toBeNull()
  expect(parseRefGuardRunId('0')).toBeNull()
})

test('a terminal run with a live agent pid produces terminal-process-alive', async () => {
  const child = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
  const id = addRun({ agent: 'grok', job: 'craft', status: 'failed' })
  db().query('UPDATE run SET pid=NULL, agent_pid=? WHERE id=?').run(child.pid, id)
  try {
    expect(pidAlive(child.pid)).toBe(true)
    expect(terminalProcessAliveConditions()).toEqual([expect.objectContaining({
      kind: 'terminal-process-alive',
      subject: `run:${id}:pid:${child.pid}`,
      detail: expect.stringContaining(`agent pid ${child.pid}`),
    })])
  } finally {
    await reapTestProcess(child.pid)
  }
})

test('a live run with a live pid produces no terminal-process-alive', () => {
  const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
  db().query('UPDATE run SET pid=? WHERE id=?').run(process.pid, id)
  expect(terminalProcessAliveConditions()).toEqual([])
})

test('a terminal run whose recorded pids are dead produces none', () => {
  const id = addRun({ agent: 'grok', job: 'craft', status: 'ok' })
  db().query('UPDATE run SET pid=?, agent_pid=? WHERE id=?').run(4_194_304, 4_194_305, id)
  expect(terminalProcessAliveConditions()).toEqual([])
})

test('a terminal run with a live descendant in the recorded pgid produces a condition', async () => {
  const child = Bun.spawn(['sleep', '30'], { detached: true, stdout: 'ignore', stderr: 'ignore' })
  try {
    expect(child.pid).toBeGreaterThan(1)
    const pgid = sampleProcesses().find((row) => row.pid === child.pid)?.pgid ?? child.pid
    const id = addRun({ agent: 'grok', job: 'craft', status: 'failed' })
    db().query('UPDATE run SET pid=?, agent_pid=?, agent_pgid=? WHERE id=?')
      .run(4_194_304, 4_194_305, pgid, id)
    expect(terminalProcessAliveConditions()).toEqual([expect.objectContaining({
      kind: 'terminal-process-alive',
      detail: expect.stringContaining(`pgid ${pgid}`),
    })])
  } finally {
    await reapTestProcess(child.pid)
  }
})

test('a reused agent pid is not reported as a leftover of a terminal run', () => {
  const id = addRun({ agent: 'grok', job: 'craft', status: 'ok' })
  db().query('UPDATE run SET pid=?, agent_pid=?, agent_start_time=? WHERE id=?')
    .run(4_194_304, process.pid, 'Sat Jan  1 00:00:00 2000', id)
  expect(pidRecordIdentity(process.pid, 'Sat Jan  1 00:00:00 2000')).toBe('reused')
  expect(terminalProcessAliveConditions()).toEqual([])
})

test('reapStale records a surviving vendor pid and does not signal it', async () => {
  const vendor = Bun.spawn(['sleep', '30'], { stdout: 'ignore', stderr: 'ignore' })
  try {
    const id = addRun({ agent: 'grok', job: 'craft', status: 'running' })
    db().query('UPDATE run SET pid=?, agent_pid=? WHERE id=?').run(4_194_304, vendor.pid, id)
    expect(reapStale(db())).toBe(1)
    const row = db().query('SELECT status, error FROM run WHERE id=?').get(id) as
      { status: string; error: string }
    expect(row.status).toBe('stale')
    expect(row.error).toContain(`vendor pid ${vendor.pid} still alive`)
    expect(pidAlive(vendor.pid)).toBe(true)
  } finally {
    await reapTestProcess(vendor.pid)
  }
})

test('injected worktree databases keep only names derived from a run id', () => {
  installTestDatabaseInventory({
    ascertainable: true,
    databases: databasesFromNames('app', 'postgres', ['app_wt_9', 'ignored', 'app_wt_10']),
  })
  expect(worktreeDatabaseInventory()).toEqual({
    ascertainable: true,
    databases: [
      { engine: 'postgres', name: 'app_wt_9', runId: 9, project: 'app' },
      { engine: 'postgres', name: 'app_wt_10', runId: 10, project: 'app' },
    ],
  })
})

test('a live run owns its database; a terminal run is reported and not dropped', () => {
  const live = addRun({ agent: 'grok', job: 'implement', status: 'running', repo: 'app' })
  const done = addRun({ agent: 'grok', job: 'implement', status: 'ok', repo: 'app' })
  installTestDatabaseInventory({
    ascertainable: true,
    databases: [
      { engine: 'postgres', name: `app_wt_${live}`, runId: live, project: 'app' },
      { engine: 'postgres', name: `app_wt_${done}`, runId: done, project: 'app' },
    ],
  })
  expect(worktreeDatabaseConditions(Date.now()).conditions).toEqual([
    expect.objectContaining({
      kind: 'orphan-worktree-database',
      subject: `postgres:app_wt_${done}`,
      action: 'reported; no established removal verb',
    }),
  ])
})

test('retained refs and ref-guard directories are inventoried without deletion', () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-resource-inv-'))
  const git = (...args: string[]) => {
    const p = Bun.spawnSync(['git', ...args], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    return p.stdout.toString().trim()
  }
  try {
    git('init', '-b', 'main')
    writeFileSync(join(repo, 'seed.txt'), 'seed\n')
    git('add', 'seed.txt')
    git('config', 'user.email', 'orch-test@example.invalid')
    git('config', 'user.name', 'Orch Test')
    git('commit', '-m', 'seed')
    const sha = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/orch/retained/9', sha)
    const guard = join(repo, '.git', 'orch-guards', '9')
    mkdirSync(guard, { recursive: true })
    writeFileSync(join(guard, 'reference-transaction'), '#!/bin/sh\nexit 0\n')
    upsertProject({ name: 'inv-app', path: repo, settings: {} })

    expect(retainedRefInventory()).toEqual({
      ascertainable: true,
      items: [expect.objectContaining({
        ref: 'refs/orch/retained/9', sha, runId: 9, project: 'inv-app',
      })],
    })
    expect(refGuardInventory()).toEqual({
      ascertainable: true,
      items: [expect.objectContaining({ runId: 9, project: 'inv-app' })],
    })
    expect(git('rev-parse', 'refs/orch/retained/9')).toBe(sha)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
})
