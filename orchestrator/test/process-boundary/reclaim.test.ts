import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  addRun, db, hermeticGitEnv, projectLockDir, reapTestProcess, score, upsertProject, worktreeLeaseName,
} from '../fixture.ts'

const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
const repos: string[] = []

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'orch-reclaim-'))
  repos.push(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.email', 'orch-test@example.invalid')
  git(repo, 'config', 'user.name', 'Orch Test')
  writeFileSync(join(repo, 'base.txt'), 'base\n')
  git(repo, 'add', 'base.txt')
  git(repo, 'commit', '-m', 'base')
  const base = git(repo, 'rev-parse', 'HEAD')
  const project = `reclaim-${repo.split('/').pop()}`
  upsertProject({ name: project, path: repo, settings: { trunk: 'main' } })
  const run = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
  score(run, 'full', 'right', 'faithful')
  const branch = `technical/DEV-391-orch-${run}`
  const tree = join(repo, '.claude', 'worktrees', `orch-${run}`)
  git(repo, 'worktree', 'add', '-b', branch, tree, 'main')
  db().query(
    `UPDATE run SET worktree=?, cwd=?, branch=?, minted_branch=?, base_commit=?,
                    worktree_source='git' WHERE id=?`,
  ).run(tree, tree, branch, branch, base, run)
  return { repo, project, run, branch, tree }
}

function orch(cwd: string, args: string[], env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd,
    env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0', ...env },
    stdout: 'pipe', stderr: 'pipe',
  })
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

function emptyProcessInventory(repo: string): Record<string, string> {
  const commands = join(repo, 'test-bin')
  mkdirSync(commands, { recursive: true })
  const ps = join(commands, 'ps')
  writeFileSync(ps, '#!/bin/sh\nexit 0\n')
  chmodSync(ps, 0o755)
  return { PATH: `${commands}:${process.env.PATH ?? ''}` }
}

async function waitFor(predicate: () => boolean, detail: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${detail}`)
    await Bun.sleep(5)
  }
}

async function childResult(child: {
  exited: Promise<number>
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
}) {
  const [code, out, err] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  return { code, out, err }
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true })
})
describe('proof-bearing reclaim verbs', () => {

  test('an unknown reclaim kind cannot reach branch reclamation', () => {
    const f = fixture()
    const before = git(f.repo, 'rev-parse', f.branch)
    const refused = orch(f.repo, ['reclaim', 'nonsense', `${f.project}:${f.branch}`])
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain('unknown reclaim kind "nonsense"')
    expect(refused.err).toContain('orch reclaim worktree <path> [--dry-run]')
    expect(refused.err).toContain('orch reclaim branch <project>:<branch> [--dry-run]')
    expect(git(f.repo, 'rev-parse', f.branch)).toBe(before)
  })

  test('sweep reclaims an orch orphan with no run row', () => {
    const f = fixture()
    db().query('DELETE FROM score WHERE run_id=?').run(f.run)
    db().query('DELETE FROM run WHERE id=?').run(f.run)

    const swept = orch(f.repo, ['sweep', '--project', f.project])
    expect(swept.code, swept.err).toBe(0)
    expect(swept.out).toContain(`reclaimed orphan  ${f.tree}`)
    expect(existsSync(f.tree)).toBe(false)
  })

  test('resume turns in the same conversation do not block worktree reclaim', () => {
    const f = fixture()
    const resumed = addRun({
      agent: 'codex', job: 'implement', status: 'ok', repo: f.project, parent: f.run, turn: 2,
    })
    db().query(
      `UPDATE run SET worktree=?, cwd=?, branch=?, minted_branch=?, base_commit=?,
                      worktree_source='git' WHERE id=?`,
    ).run(f.tree, f.tree, f.branch, f.branch, git(f.repo, 'rev-parse', 'main'), resumed)

    const removed = orch(f.repo, ['reclaim', 'worktree', f.tree])
    expect(removed.code, removed.err).toBe(0)
    expect(existsSync(f.tree)).toBe(false)
  })

  test('worktree reclaim waits on its lease before taking the cleanup purpose lock', async () => {
    const f = fixture()
    const ready = join(f.repo, 'lease-ready')
    const release = join(f.repo, 'lease-release')
    const module = new URL('../../src/worktree.ts', import.meta.url).pathname
    const holder = Bun.spawn([
      process.execPath, '-e',
      `const{existsSync,writeFileSync}=await import('node:fs');` +
      `const{withWorktreeLease}=await import(process.argv[1]);` +
      `const[repo,tree,ready,release]=process.argv.slice(2);` +
      `withWorktreeLease(repo,tree,{session:'holder',what:'test holder'},()=>{` +
      `writeFileSync(ready,'');while(!existsSync(release))` +
      `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5)},5000)`,
      module, f.repo, f.tree, ready, release,
    ], { env: { ...process.env, ORCH_DB: process.env.ORCH_DB! }, stdout: 'pipe', stderr: 'pipe' })
    let reclaim: ReturnType<typeof Bun.spawn> | undefined
    try {
      await waitFor(() => existsSync(ready), 'lease holder')

      reclaim = Bun.spawn([process.execPath, CLI, 'reclaim', 'worktree', f.tree], {
        cwd: f.repo,
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      const locks = projectLockDir(f.repo)
      const leaseWaiters = join(locks, `orch-${worktreeLeaseName(f.tree)}.waiters`, '.legacy')
      await waitFor(
        () => existsSync(leaseWaiters) && readdirSync(leaseWaiters).some((name) => !name.startsWith('.')),
        'reclaim lease waiter',
      )
      const common = git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
      const createHeldWhileWaiting = existsSync(join(common, 'orch-create.lock'))
      const cleanupHeldWhileWaiting = existsSync(join(common, 'orch-cleanup.lock'))
      writeFileSync(release, '')
      const [held, reclaimed] = await Promise.all([childResult(holder), childResult(reclaim)])
      expect(held.code, held.err).toBe(0)
      expect(reclaimed.code, reclaimed.err).toBe(0)
      expect(createHeldWhileWaiting).toBe(false)
      expect(cleanupHeldWhileWaiting).toBe(false)
      expect(existsSync(f.tree)).toBe(false)
    } finally {
      writeFileSync(release, '')
      await reapTestProcess(holder.pid)
      await reapTestProcess(reclaim?.pid)
    }
  }, 10_000)

  test('worktree dry-run and reclaim preserve its recorded identity', () => {
    const f = fixture()
    const preview = orch(f.repo, ['reclaim', 'worktree', f.tree, '--dry-run'])
    expect(preview.code, preview.err).toBe(0)
    expect(preview.out).toContain('committed work is retained by its branch')
    expect(existsSync(f.tree)).toBe(true)

    const removed = orch(f.repo, ['reclaim', 'worktree', f.tree])
    expect(removed.code, removed.err).toBe(0)
    expect(existsSync(f.tree)).toBe(false)
    expect(db().query('SELECT worktree, branch_kept, branch_kept_tip FROM run WHERE id=?').get(f.run))
      .toEqual({ worktree: f.tree, branch_kept: f.branch, branch_kept_tip: git(f.repo, 'rev-parse', f.branch) })
  })

  test('worktree reclaim extracts uncommitted paths and removes the tree', () => {
    const f = fixture()
    writeFileSync(join(f.tree, 'one.txt'), 'one\n')
    writeFileSync(join(f.tree, 'two.txt'), 'two\n')
    const preview = orch(f.repo, ['reclaim', 'worktree', f.tree, '--dry-run'])
    expect(preview.code, preview.err).toBe(0)
    expect(existsSync(f.tree)).toBe(true)

    const removed = orch(f.repo, ['reclaim', 'worktree', f.tree])
    expect(removed.code, removed.err).toBe(0)
    expect(existsSync(f.tree)).toBe(false)
    const artifacts = join(process.env.ORCH_RUNS!, String(f.run), 'artifacts')
    const record = JSON.parse(readFileSync(join(artifacts, 'extraction.json'), 'utf8')) as {
      ok: boolean; untrackedCount: number
    }
    expect(record.ok).toBe(true)
    expect(record.untrackedCount).toBe(2)
    expect(readFileSync(join(artifacts, 'untracked', 'one.txt'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(artifacts, 'untracked', 'two.txt'), 'utf8')).toBe('two\n')
  })

  test('worktree reclaim keeps commits absent from trunk on the retained branch', () => {
    const f = fixture()
    writeFileSync(join(f.tree, 'unique.txt'), 'unique\n')
    git(f.tree, 'add', 'unique.txt')
    git(f.tree, 'commit', '-m', 'unique')
    const tip = git(f.tree, 'rev-parse', 'HEAD')

    expect(git(f.repo, 'rev-list', 'HEAD', '--not', 'main')).toBe('')
    expect(git(f.tree, 'rev-list', 'HEAD', '--not', 'main')).toBe(tip)

    const preview = orch(f.repo, ['reclaim', 'worktree', f.tree, '--dry-run'])
    expect(preview.code, preview.err).toBe(0)
    const removed = orch(f.repo, ['reclaim', 'worktree', f.tree])
    expect(removed.code, removed.err).toBe(0)
    expect(existsSync(f.tree)).toBe(false)
    expect(git(f.repo, 'rev-parse', f.branch)).toBe(tip)
    expect(db().query('SELECT worktree, branch_kept, branch_kept_tip FROM run WHERE id=?').get(f.run))
      .toEqual({ worktree: f.tree, branch_kept: f.branch, branch_kept_tip: tip })
  })

  test('branch refusal names unreachable commits and exact kept-tip proof permits deletion', () => {
    const f = fixture()
    writeFileSync(join(f.tree, 'unique.txt'), 'unique\n')
    git(f.tree, 'add', 'unique.txt')
    git(f.tree, 'commit', '-m', 'unique')
    const tip = git(f.tree, 'rev-parse', 'HEAD')
    git(f.repo, 'worktree', 'remove', '--force', f.tree)

    const refused = orch(f.repo, ['reclaim', 'branch', `${f.project}:${f.branch}`, '--dry-run'])
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain(`commits unreachable from landing branch main: ${tip}`)

    db().query('UPDATE run SET branch_kept=?, branch_kept_tip=? WHERE id=?')
      .run(f.branch, tip, f.run)
    const removed = orch(f.repo, ['reclaim', 'branch', `${f.project}:${f.branch}`])
    expect(removed.code, removed.err).toBe(0)
    expect(git(f.repo, 'branch', '--list', f.branch)).toBe('')
  })

  test('branch deletion compares against the exact tip proved under the lock', () => {
    const f = fixture()
    git(f.repo, 'worktree', 'remove', '--force', f.tree)
    git(f.repo, 'switch', '-c', 'moved-tip', 'main')
    writeFileSync(join(f.repo, 'moved.txt'), 'moved after proof\n')
    git(f.repo, 'add', 'moved.txt')
    git(f.repo, 'commit', '-m', 'moved after proof')
    const movedTip = git(f.repo, 'rev-parse', 'HEAD')
    git(f.repo, 'switch', 'main')
    git(f.repo, 'branch', '-D', 'moved-tip')

    const bin = join(f.repo, 'moving-git')
    mkdirSync(bin)
    const realGit = Bun.spawnSync(['which', 'git']).stdout.toString().trim()
    const movedMarker = join(bin, 'moved')
    const readCount = join(bin, 'reads')
    writeFileSync(join(bin, 'git'), `#!/bin/sh
if [ "$1 $2 $3" = "rev-parse --verify refs/heads/${f.branch}" ]; then
  count=0
  [ -f "${readCount}" ] && count=$(cat "${readCount}")
  count=$((count + 1))
  printf '%s' "$count" > "${readCount}"
  if [ "$count" = 3 ]; then
    "${realGit}" update-ref "refs/heads/${f.branch}" "${movedTip}"
    : > "${movedMarker}"
  fi
fi
if [ "$1 $2" = "update-ref -d" ] && [ ! -f "${movedMarker}" ]; then
  "${realGit}" update-ref "$3" "${movedTip}"
  : > "${movedMarker}"
fi
exec "${realGit}" "$@"
`)
    chmodSync(join(bin, 'git'), 0o755)

    const result = orch(
      f.repo,
      ['reclaim', 'branch', `${f.project}:${f.branch}`],
      { PATH: `${bin}:${process.env.PATH ?? ''}` },
    )
    expect(git(f.repo, 'branch', '--list', f.branch)).toBe(f.branch)
    expect(git(f.repo, 'rev-parse', f.branch)).toBe(movedTip)
    expect(result.code).not.toBe(0)
    expect(result.err).toContain(`git did not delete branch ${f.project}:${f.branch} at proved tip`)
  })
})
