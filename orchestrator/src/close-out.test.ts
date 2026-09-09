import { afterEach, beforeEach, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  addRun, closeOutRun, createWorktree, db, hermeticGitEnv, upsertProject,
  verifiedProcessTree, worktreeLeaseName, projectLockDir, monitor, fakeDocker,
  installTestProcessInventory, score,
} from '../test/fixture.ts'

beforeEach(() => installTestProcessInventory({ ascertainable: true, rows: [] }))
afterEach(() => installTestProcessInventory(null))

function git(cwd: string, ...args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], {
    cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
  })
  if (p.exitCode !== 0) throw new Error(p.stderr.toString())
  return p.stdout.toString().trim()
}

function fixture(status = 'ok') {
  const repo = mkdtempSync(join(tmpdir(), 'orch-close-out-'))
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Orch Test')
  git(repo, 'config', 'user.email', 'orch@example.invalid')
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, 'add', 'base.txt')
  git(repo, 'commit', '-m', 'base')
  const project = `close-out-${randomUUID()}`
  upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
  const id = addRun({ agent: 'codex', job: 'implement', status, repo })
  const tree = createWorktree(repo, id)
  db().query(
    `UPDATE run SET repo=?, cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=?, worktree_source='git'
      WHERE id=?`,
  ).run(project, tree.path, tree.path, tree.branch, tree.branch, tree.base, id)
  return { repo, project, id, tree }
}

test('close-out releases a fully committed tree and keeps its branch', () => {
  const f = fixture()
  try {
    writeFileSync(join(f.tree.path, 'work.txt'), 'done\n')
    git(f.tree.path, 'add', 'work.txt')
    git(f.tree.path, 'commit', '-m', 'DEV-410 work')
    const tip = git(f.tree.path, 'rev-parse', 'HEAD')
    db().query('UPDATE run SET head_commit=? WHERE id=?').run(tip, f.id)
    const result = closeOutRun(f.id, { intent: 'terminal' })
    expect(result.outcome).toBe('released')
    expect(existsSync(f.tree.path)).toBe(false)
    expect(git(f.repo, 'rev-parse', f.tree.branch)).toBe(tip)
    expect(db().query(
      'SELECT worktree, branch, branch_kept, branch_kept_tip, head_commit FROM run WHERE id=?',
    ).get(f.id)).toEqual({
      worktree: f.tree.path,
      branch: f.tree.branch,
      branch_kept: f.tree.branch,
      branch_kept_tip: tip,
      head_commit: tip,
    })
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

for (const kind of ['tracked', 'untracked'] as const) test(`close-out holds ${kind} work`, () => {
  const f = fixture()
  try {
    if (kind === 'tracked') writeFileSync(join(f.tree.path, 'base.txt'), 'changed\n')
    else writeFileSync(join(f.tree.path, 'new.txt'), 'new\n')
    const result = closeOutRun(f.id, { intent: 'terminal' })
    expect(result.outcome).toBe('held')
    expect(result.detail).toContain('uncommitted or untracked')
    expect(existsSync(f.tree.path)).toBe(true)
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

test('a running sibling sharing the tree wins over clean release', () => {
  const f = fixture()
  try {
    const sibling = addRun({ agent: 'codex', job: 'understand', status: 'running', repo: f.project })
    db().query('UPDATE run SET worktree=? WHERE id=?').run(f.tree.path, sibling)
    const result = closeOutRun(f.id, { intent: 'terminal' })
    expect(result.outcome).toBe('live')
    expect(result.detail).toContain(`${sibling} (running)`)
    expect(existsSync(f.tree.path)).toBe(true)
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

for (const siblingStatus of ['running', 'ok'] as const) {
  for (const intent of ['terminal', 'explicit', 'sweep'] as const) {
    for (const ascertainable of [true, false]) {
      test(`finished-run composition: ${siblingStatus} sibling, ${intent} intent, ` +
        `${ascertainable ? 'ascertainable' : 'unascertainable'} processes`, () => {
        const f = fixture()
        try {
          const sibling = addRun({
            agent: 'codex', job: 'understand', status: siblingStatus, repo: f.project,
          })
          db().query('UPDATE run SET worktree=? WHERE id=?').run(`${f.tree.path}/`, sibling)
          installTestProcessInventory(ascertainable
            ? { ascertainable: true, rows: [] }
            : { ascertainable: false, reason: 'composition process inventory unavailable' })

          const result = closeOutRun(f.id, { intent })
          const releases = siblingStatus === 'ok' && ascertainable && intent !== 'sweep'
          expect(result.outcome).toBe(releases ? 'released' : 'live')
          expect(existsSync(f.tree.path)).toBe(!releases)
          if (siblingStatus === 'running') expect(result.detail).toContain(`${sibling} (running)`)
          if (!ascertainable && siblingStatus === 'ok') {
            expect(result.detail).toContain('process liveness could not be established')
          }
          if (intent === 'sweep' && siblingStatus === 'ok' && ascertainable) {
            expect(result.detail).toContain('two-hour liveness window')
          }
        } finally { rmSync(f.repo, { recursive: true, force: true }) }
      })
    }
  }
}

test('sweep releases an aged finished tree despite a terminal sibling claim', () => {
  const f = fixture()
  try {
    const sibling = addRun({ agent: 'codex', job: 'understand', status: 'ok', repo: f.project })
    db().query('UPDATE run SET worktree=? WHERE id=?').run(`${f.tree.path}/`, sibling)
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
    for (const name of git(f.tree.path, 'ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean)) {
      utimesSync(join(f.tree.path, name), old, old)
    }
    const result = closeOutRun(f.id, { intent: 'sweep' })
    expect(result.outcome).toBe('released')
    expect(existsSync(f.tree.path)).toBe(false)
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

test('sweep and abandon ignore terminal claimants while closing out', () => {
  for (const verb of ['sweep', 'abandon'] as const) {
    const f = fixture(verb === 'abandon' ? 'asking' : 'ok')
    try {
      db().query('UPDATE run SET session_id=? WHERE id=?').run('close-out-test-session', f.id)
      const sibling = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: f.project })
      score(sibling, 'full', 'right', 'faithful')
      db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
        .run(f.tree.path, f.tree.branch, sibling)
      const args = verb === 'sweep' ? ['sweep', '--dry-run'] : ['abandon', String(f.id)]
      if (verb === 'sweep') {
        score(f.id, 'full', 'right', 'faithful')
        db().query('UPDATE run SET started_at=? WHERE id IN (?, ?)')
          .run('2020-01-01T00:00:00.000Z', f.id, sibling)
        const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
        utimesSync(join(f.tree.path, 'base.txt'), old, old)
      }
      const cli = new URL('cli.ts', import.meta.url).pathname
      const commands = join(f.repo, 'test-bin')
      mkdirSync(commands)
      const ps = join(commands, 'ps')
      writeFileSync(ps, '#!/bin/sh\nexit 0\n')
      chmodSync(ps, 0o755)
      const result = Bun.spawnSync([process.execPath, cli, ...args], {
        env: {
          ...process.env,
          PATH: `${commands}:${process.env.PATH ?? ''}`,
          CLAUDE_CODE_SESSION_ID: 'close-out-test-session',
          ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        },
        stdout: 'pipe', stderr: 'pipe',
      })

      expect(result.exitCode, result.stderr.toString()).toBe(0)
      if (verb === 'sweep') {
        expect(result.stdout.toString()).toContain(`would reclaim ${f.id}  ${f.tree.path}`)
        expect(existsSync(f.tree.path)).toBe(true)
      } else {
        expect(result.stdout.toString()).toContain('released worktree:')
        expect(existsSync(f.tree.path)).toBe(false)
      }
    } finally { rmSync(f.repo, { recursive: true, force: true }) }
  }
})

test('a live process tree wins over database-only terminal liveness', () => {
  const f = fixture()
  try {
    const result = closeOutRun(f.id, {
      intent: 'terminal',
      extraPids: [process.pid],
    })
    expect(result.outcome).toBe('live')
    expect(result.detail).toBe('process tree still alive')
    expect(existsSync(f.tree.path)).toBe(true)
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

test('a live terminal sibling turn process retains the conversation tree', () => {
  const f = fixture()
  const sleeper = Bun.spawn(['sleep', '30'], { stdout: 'pipe', stderr: 'pipe' })
  try {
    const child = addRun({ agent: 'codex', job: 'implement', status: 'ok', parent: f.id, turn: 2 })
    db().query('UPDATE run SET worktree=?, branch=?, agent_pid=? WHERE id=?')
      .run(f.tree.path, f.tree.branch, sleeper.pid, child)
    installTestProcessInventory({ ascertainable: true, rows: [
      { pid: sleeper.pid, ppid: process.pid, pgid: sleeper.pid, command: 'sleep 30' },
    ] })
    const result = closeOutRun(f.id, { intent: 'explicit' })
    expect(result.outcome).toBe('live')
    expect(result.detail).toBe('process tree still alive')
    expect(existsSync(f.tree.path)).toBe(true)
  } finally {
    sleeper.kill()
    rmSync(f.repo, { recursive: true, force: true })
  }
})

test('a live terminal process on another root sharing the worktree retains the tree', () => {
  const f = fixture()
  const sleeper = Bun.spawn(['sleep', '30'], { stdout: 'pipe', stderr: 'pipe' })
  try {
    const sibling = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: f.project })
    db().query('UPDATE run SET worktree=?, branch=?, agent_pid=? WHERE id=?')
      .run(f.tree.path, f.tree.branch, sleeper.pid, sibling)
    installTestProcessInventory({ ascertainable: true, rows: [
      { pid: sleeper.pid, ppid: process.pid, pgid: sleeper.pid, command: 'sleep 30' },
    ] })
    const result = closeOutRun(f.id, { intent: 'explicit' })
    expect(result.outcome).toBe('live')
    expect(result.detail).toBe('process tree still alive')
    expect(existsSync(f.tree.path)).toBe(true)
  } finally {
    sleeper.kill()
    rmSync(f.repo, { recursive: true, force: true })
  }
})

test('another root recording the same tree under a different spelling retains it', () => {
  const f = fixture()
  const sleeper = Bun.spawn(['sleep', '30'], { stdout: 'pipe', stderr: 'pipe' })
  try {
    // run.worktree stores whatever the caller spelled. A trailing separator is
    // the same tree, and raw string equality misses it - which released a tree
    // whose other owner was still running.
    const sibling = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: f.project })
    db().query('UPDATE run SET worktree=?, branch=?, agent_pid=? WHERE id=?')
      .run(`${f.tree.path}/`, f.tree.branch, sleeper.pid, sibling)
    installTestProcessInventory({ ascertainable: true, rows: [
      { pid: sleeper.pid, ppid: process.pid, pgid: sleeper.pid, command: 'sleep 30' },
    ] })
    const result = closeOutRun(f.id, { intent: 'explicit' })
    expect(result.outcome).toBe('live')
    expect(existsSync(f.tree.path)).toBe(true)
  } finally {
    sleeper.kill()
    rmSync(f.repo, { recursive: true, force: true })
  }
})

test("the Stop hook's non-blocking close-out command parses and runs", () => {
  const id = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
  const orch = new URL('../../bin/orch', import.meta.url).pathname
  const result = Bun.spawnSync([orch, 'close-out', String(id), '--non-blocking'], {
    env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
    stdout: 'pipe', stderr: 'pipe',
  })
  expect(result.exitCode, result.stderr.toString()).toBe(0)
  expect(result.stderr.toString()).not.toContain('unrecognised argument')
  expect(result.stdout.toString()).toContain(`absent run ${id}: no worktree`)
})

test('unascertainable process inventory retains the tree with the missing condition', () => {
  const f = fixture()
  try {
    installTestProcessInventory({ ascertainable: false, reason: 'process inventory unavailable: EPERM' })
    const result = closeOutRun(f.id, { intent: 'explicit' })
    expect(result.outcome).toBe('live')
    expect(result.detail).toContain('EPERM')
    expect(result.detail).toContain('process liveness could not be established')
    expect(existsSync(f.tree.path)).toBe(true)
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

test('a live recorded coordinator retains the tree without relying on command identity', () => {
  const f = fixture()
  const coordinator = Bun.spawn(['sleep', '30'], { stdout: 'pipe', stderr: 'pipe' })
  try {
    db().query('UPDATE run SET pid=? WHERE id=?').run(coordinator.pid, f.id)
    const result = closeOutRun(f.id, { intent: 'explicit' })
    expect(result.outcome).toBe('live')
    expect(result.detail).toBe(`recorded coordinator pid ${coordinator.pid} for run ${f.id} is still alive`)
    expect(existsSync(f.tree.path)).toBe(true)
  } finally {
    coordinator.kill()
    rmSync(f.repo, { recursive: true, force: true })
  }
})

test('a retained git ref protects the tip while a project remover deletes its branch', () => {
  const f = fixture()
  const observed = join(f.repo, 'retained-tip')
  try {
    writeFileSync(join(f.tree.path, 'work.txt'), 'done\n')
    git(f.tree.path, 'add', 'work.txt')
    git(f.tree.path, 'commit', '-m', 'DEV-410 retained ref fixture')
    const tip = git(f.tree.path, 'rev-parse', 'HEAD')
    const remover = join(f.repo, 'remove-tree.sh')
    writeFileSync(remover,
      `git rev-parse refs/orch/retained/${f.id} > "${observed}"\n` +
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: f.project, path: f.repo,
      settings: { trunk: 'main', worktree: { remove: `sh "${remover}" {path} {branch}` } },
    })
    db().query("UPDATE run SET worktree_source='recipe' WHERE id=?").run(f.id)
    const result = closeOutRun(f.id, { intent: 'explicit' })
    expect(result.outcome).toBe('released')
    expect(readFileSync(observed, 'utf8').trim()).toBe(tip)
    expect(git(f.repo, 'rev-parse', f.tree.branch)).toBe(tip)
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

test('explicit close-out ignores recent filesystem activity', () => {
  const f = fixture()
  try {
    const result = closeOutRun(f.id, { intent: 'explicit' })
    expect(result.outcome).toBe('released')
    expect(existsSync(f.tree.path)).toBe(false)
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

test('live worktree lease is handled conservatively', async () => {
  const f = fixture()
  const ready = join(f.repo, 'lease-ready')
  const release = join(f.repo, 'lease-release')
  const child = Bun.spawn([
    process.execPath, '-e',
    `const{existsSync,writeFileSync}=await import('node:fs');` +
    `const{withProjectLock}=await import(process.argv[1]);` +
    `withProjectLock(process.argv[2],process.argv[3],{session:'fixture',what:'live lease'},()=>{` +
    `writeFileSync(process.argv[4],'');while(!existsSync(process.argv[5]))` +
    `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)},5000)`,
    new URL('worktree.ts', import.meta.url).href, f.repo, worktreeLeaseName(f.tree.path), ready, release,
  ], { env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
  try {
    for (let i = 0; i < 200 && !existsSync(ready); i++) await Bun.sleep(5)
    expect(existsSync(ready)).toBe(true)
    const result = closeOutRun(f.id, { intent: 'terminal' })
    expect(result.outcome).toBe('live')
    expect(existsSync(f.tree.path)).toBe(true)
  } finally {
    writeFileSync(release, '')
    await child.exited
    rmSync(f.repo, { recursive: true, force: true })
  }
})

test('dead-holder metadata does not confer worktree liveness', () => {
  const f = fixture()
  const name = worktreeLeaseName(f.tree.path)
  const runtime = projectLockDir(f.repo)
  mkdirSync(runtime, { recursive: true })
  writeFileSync(join(runtime, `orch-${name}.owner`), JSON.stringify({
    pid: 999_999, session: 'test', what: 'dead lease', since: new Date().toISOString(),
    startTime: null, incarnation: 'dead',
  }))
  try {
    expect(closeOutRun(f.id, { intent: 'terminal' }).outcome).toBe('released')
    expect(existsSync(f.tree.path)).toBe(false)
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

test('resume identity keeps the root tree while any turn is live', () => {
  const f = fixture('running')
  try {
    const child = addRun({ agent: 'codex', job: 'implement', status: 'ok', parent: f.id, turn: 2 })
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?').run(f.tree.path, f.tree.branch, child)
    expect(closeOutRun(child, { intent: 'terminal' }).outcome).toBe('live')
    db().query("UPDATE run SET status='ok' WHERE id=?").run(f.id)
    expect(closeOutRun(child, { intent: 'terminal' }).outcome).toBe('released')
    expect(existsSync(f.tree.path)).toBe(false)
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

test('process reaping selects the whole verified tree youngest-first and rejects pid reuse', () => {
  const rows = [
    { pid: 10, ppid: 1, pgid: 10, command: 'bun /repo/orchestrator/src/exec.ts 44 prompt implement' },
    { pid: 11, ppid: 10, pgid: 10, command: 'vendor' },
    { pid: 12, ppid: 11, pgid: 10, command: 'gateway' },
    { pid: 99, ppid: 1, pgid: 99, command: 'bun run dev' },
  ]
  expect(verifiedProcessTree(rows, 44, 10)).toEqual([12, 11, 10])
  expect(verifiedProcessTree(rows, 44, 99)).toEqual([])
  expect(verifiedProcessTree(rows, 45, 10)).toEqual([])
})

test('monitor reports dirty and explicit holds and escalates them at 48h', async () => {
  const dirty = fixture()
  const explicit = fixture()
  const docker = fakeDocker([], [])
  const priorPath = process.env.PATH
  try {
    writeFileSync(join(dirty.tree.path, 'new.txt'), 'held\n')
    const old = new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString()
    db().query('UPDATE run SET started_at=? WHERE id=?').run(old, dirty.id)
    db().query('UPDATE run SET started_at=?, keep_tree=1 WHERE id=?').run(old, explicit.id)
    expect(db().query('SELECT repo,worktree,keep_tree FROM run WHERE id=?').get(dirty.id))
      .toEqual({ repo: dirty.project, worktree: dirty.tree.path, keep_tree: 0 })
    process.env.PATH = docker.env.PATH
    const result = await monitor('invoked')
    expect(result.conditions).toContainEqual(expect.objectContaining({
      kind: 'held-worktree', subject: dirty.tree.path, severity: 'attention',
    }))
    expect(result.conditions).toContainEqual(expect.objectContaining({
      kind: 'explicitly-held-worktree', subject: explicit.tree.path,
      detail: expect.stringContaining('--keep-tree'), severity: 'attention',
    }))
  } finally {
    if (priorPath === undefined) delete process.env.PATH
    else process.env.PATH = priorPath
    rmSync(docker.dir, { recursive: true, force: true })
    rmSync(dirty.repo, { recursive: true, force: true })
    rmSync(explicit.repo, { recursive: true, force: true })
  }
})
