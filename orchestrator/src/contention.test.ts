import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyMigrations } from './migrations.ts'
import { db, DB_PATH, hermeticGitEnv, withProjectLock } from '../test/fixture.ts'
import { insertContention, tryInsertContention } from './contention.ts'

describe('contention ledger', () => {
  test('withProjectLock wait and timeout each write a row', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-contention-lock-'))
    const git = (args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'orch-test@example.invalid'])
    git(['config', 'user.name', 'Orch Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(['add', 'base.txt'])
    git(['commit', '-m', 'base'])
    expect(db()).toBeDefined()
    const ready = join(repo, 'ready')
    const release = join(repo, 'release')
    const worktreeModule = new URL('./worktree.ts', import.meta.url).href
    const holder = Bun.spawn([
      process.execPath, '-e',
      `const { writeFileSync, existsSync } = await import('node:fs');
       const { withProjectLock } = await import(process.argv[1]);
       withProjectLock(process.argv[2], 'landing', { session: 'holder', what: 'hold' }, () => {
         writeFileSync(process.argv[3], '');
         while (!existsSync(process.argv[4])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
       }, 20_000, true)`,
      worktreeModule, repo, ready, release,
    ], { env: { ...process.env, ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe' })
    try {
      for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(5)
      expect(existsSync(ready)).toBe(true)
      expect(() => withProjectLock(
        repo, 'landing', { session: 'waiter', what: 'wait' }, () => 'acquired', 80, true,
      )).toThrow(/timed out after/)
      const timeout = db().query(
        `SELECT resource_kind, event_kind, resource_key, session_id FROM contention
          WHERE event_kind='timeout' AND session_id='waiter'`,
      ).get() as { resource_kind: string; event_kind: string; resource_key: string; session_id: string }
      expect(timeout).toEqual({
        resource_kind: 'lock', event_kind: 'timeout', resource_key: 'landing', session_id: 'waiter',
      })
      const dbModule = new URL('./db.ts', import.meta.url).href
      const waiter = Bun.spawn([
        process.execPath, '-e',
        `const { db } = await import(process.argv[1]);
         const { withProjectLock } = await import(process.argv[2]);
         db();
         withProjectLock(process.argv[3], 'landing', { session: 'queued', what: 'queued' }, () => 'ok', 20_000, true)`,
        dbModule, worktreeModule, repo,
      ], { env: { ...process.env, ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe' })
      for (let i = 0; i < 50; i++) await Bun.sleep(10)
      writeFileSync(release, '')
      expect(await holder.exited).toBe(0)
      expect(await waiter.exited).toBe(0)
      const wait = db().query(
        `SELECT resource_kind, event_kind, resource_key, session_id FROM contention
          WHERE event_kind='wait' AND session_id='queued'`,
      ).get() as { resource_kind: string; event_kind: string; resource_key: string; session_id: string }
      expect(wait).toEqual({
        resource_kind: 'lock', event_kind: 'wait', resource_key: 'landing', session_id: 'queued',
      })
    } finally {
      holder.kill()
      await holder.exited
      rmSync(repo, { recursive: true, force: true })
    }
  }, 15_000)

  test('lock timeout recording does not stall on a reserved store', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-contention-lock-busy-'))
    const git = (args: string[]) => {
      const result = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    }
    git(['init', '-b', 'main'])
    git(['config', 'user.email', 'orch-test@example.invalid'])
    git(['config', 'user.name', 'Orch Test'])
    writeFileSync(join(repo, 'base.txt'), 'base\n')
    git(['add', 'base.txt'])
    git(['commit', '-m', 'base'])
    expect(db()).toBeDefined()
    const ready = join(repo, 'ready')
    const release = join(repo, 'release')
    const worktreeModule = new URL('./worktree.ts', import.meta.url).href
    const holder = Bun.spawn([
      process.execPath, '-e',
      `const { writeFileSync, existsSync } = await import('node:fs');
       const { withProjectLock } = await import(process.argv[1]);
       withProjectLock(process.argv[2], 'landing', { session: 'holder', what: 'hold' }, () => {
         writeFileSync(process.argv[3], '');
         while (!existsSync(process.argv[4])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
       }, 20_000, true)`,
      worktreeModule, repo, ready, release,
    ], { env: { ...process.env, ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe' })
    const blocker = new Database(DB_PATH, { readwrite: true, create: false })
    try {
      for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(5)
      expect(existsSync(ready)).toBe(true)
      blocker.exec('BEGIN IMMEDIATE')
      const timeoutMs = 0
      const started = Date.now()
      expect(() => withProjectLock(
        repo, 'landing', { session: 'busy-waiter', what: 'wait' }, () => 'acquired', timeoutMs, true,
      )).toThrow(/timed out after/)
      // The invariant is that recording never waits the 15 s busy_timeout while
      // a lock timeout is being thrown. A 50 ms bound proved it on an idle
      // machine and failed at 292 ms under two concurrent lens suites; a bound
      // an order of magnitude below busy_timeout proves the same thing and
      // survives load (DEV-375's size-class rule for sub-second bounds).
      expect(Date.now() - started).toBeLessThan(timeoutMs + 2_000)
      expect(db().query(
        "SELECT 1 FROM contention WHERE session_id='busy-waiter'",
      ).get()).toBeNull()
    } finally {
      try { blocker.exec('ROLLBACK') } catch { /* already closed or not in a txn */ }
      blocker.close()
      writeFileSync(release, '')
      holder.kill()
      await holder.exited
      rmSync(repo, { recursive: true, force: true })
    }
  }, 15_000)

  test('a behind store that already has the table records store/refusal then refuses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orch-contention-behind-'))
    const path = join(dir, 'behind.db')
    const seed = new Database(path)
    seed.exec('PRAGMA foreign_keys=ON')
    applyMigrations(seed)
    seed.exec('DELETE FROM orch_migrations WHERE created_at=1788900000001')
    expect(seed.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contention'").get())
      .toBeDefined()
    seed.close()
    const opened = Bun.spawnSync([
      process.execPath, new URL('./cli.ts', import.meta.url).pathname, 'runs',
    ], { env: { ...process.env, ORCH_DB: path, ORCH_DEPTH: '0' }, stdout: 'pipe', stderr: 'pipe' })
    expect(opened.exitCode).not.toBe(0)
    expect(opened.stderr.toString()).toContain('cleared by: orch migrate')
    const check = new Database(path)
    expect(check.query(
      'SELECT resource_kind, event_kind FROM contention',
    ).get()).toEqual({ resource_kind: 'store', event_kind: 'refusal' })
    check.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test('tryInsertContention never throws when the handle is missing', () => {
    expect(() => tryInsertContention(null, {
      resourceKind: 'lock', resourceKey: 'landing', eventKind: 'wait',
    })).not.toThrow()
    insertContention(db(), {
      resourceKind: 'cpu', resourceKey: 'fixture', eventKind: 'timeout', durationMs: 5,
    })
    expect(db().query(
      "SELECT resource_kind, event_kind FROM contention WHERE resource_key='fixture'",
    ).get()).toEqual({ resource_kind: 'cpu', event_kind: 'timeout' })
  })
})

describe('one-shot contention writes honour the stale-schema invariant', () => {
  test('a busy_timeout-0 write after another process bumped user_version records nothing', () => {
    expect(db()).toBeDefined()
    const { tryWriteContention, DB_PATH: path } = require('./db.ts') as typeof import('./db.ts')
    const other = new Database(path, { readwrite: true, create: false })
    const before = (other.query('PRAGMA user_version').get() as { user_version: number }).user_version
    try {
      other.exec(`PRAGMA user_version = ${before + 1}`)
      tryWriteContention({
        sessionId: 'stale-writer', resourceKind: 'lock', resourceKey: 'landing', eventKind: 'timeout',
        cause: 'stale schema probe',
      }, { busyTimeoutMs: 0 })
      expect(db().query("SELECT 1 FROM contention WHERE session_id='stale-writer'").get()).toBeNull()
      other.exec(`PRAGMA user_version = ${before}`)
      tryWriteContention({
        sessionId: 'current-writer', resourceKind: 'lock', resourceKey: 'landing', eventKind: 'timeout',
        cause: 'current schema probe',
      }, { busyTimeoutMs: 0 })
      expect(db().query("SELECT 1 FROM contention WHERE session_id='current-writer'").get()).not.toBeNull()
    } finally {
      other.close()
    }
  })
})
