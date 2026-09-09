import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  addRun, closeOutRun, createWorktree, db, hermeticGitEnv, upsertProject,
  verifiedProcessTree, worktreeLeaseName, projectLockDir, monitor, fakeDocker,
} from '../test/fixture.ts'

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
    const result = closeOutRun(f.id, { terminalAt: Date.now() + 1 })
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
    const result = closeOutRun(f.id, { terminalAt: Date.now() + 1 })
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
    const result = closeOutRun(f.id, { terminalAt: Date.now() + 1 })
    expect(result.outcome).toBe('live')
    expect(result.detail).toContain(`${sibling} (running)`)
    expect(existsSync(f.tree.path)).toBe(true)
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

test('a live process tree wins over database-only terminal liveness', () => {
  const f = fixture()
  try {
    const result = closeOutRun(f.id, {
      terminalAt: Date.now() + 1,
      extraPids: [process.pid],
    })
    expect(result.outcome).toBe('live')
    expect(result.detail).toBe('process tree still alive')
    expect(existsSync(f.tree.path)).toBe(true)
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

test('post-terminal filesystem activity wins over clean release', () => {
  const f = fixture()
  try {
    const terminalAt = Date.now() - 1_000
    writeFileSync(join(f.tree.path, 'base.txt'), 'base\n')
    const result = closeOutRun(f.id, { terminalAt })
    expect(result.outcome).toBe('live')
    expect(result.detail).toContain('after terminalisation')
    expect(existsSync(f.tree.path)).toBe(true)
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
    const result = closeOutRun(f.id, { terminalAt: Date.now() + 1 })
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
    expect(closeOutRun(f.id, { terminalAt: Date.now() + 1 }).outcome).toBe('released')
    expect(existsSync(f.tree.path)).toBe(false)
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

test('resume identity keeps the root tree while any turn is live', () => {
  const f = fixture('running')
  try {
    const child = addRun({ agent: 'codex', job: 'implement', status: 'ok', parent: f.id, turn: 2 })
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?').run(f.tree.path, f.tree.branch, child)
    expect(closeOutRun(child, { terminalAt: Date.now() + 1 }).outcome).toBe('live')
    db().query("UPDATE run SET status='ok' WHERE id=?").run(f.id)
    expect(closeOutRun(child, { terminalAt: Date.now() + 1 }).outcome).toBe('released')
    expect(existsSync(f.tree.path)).toBe(false)
  } finally { rmSync(f.repo, { recursive: true, force: true }) }
})

test('process reaping selects the whole verified tree youngest-first and rejects pid reuse', () => {
  const rows = [
    { pid: 10, ppid: 1, command: 'bun /repo/orchestrator/src/exec.ts 44 prompt implement' },
    { pid: 11, ppid: 10, command: 'vendor' },
    { pid: 12, ppid: 11, command: 'gateway' },
    { pid: 99, ppid: 1, command: 'bun run dev' },
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
