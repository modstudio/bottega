import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun, db, hermeticGitEnv, score, upsertProject } from '../test/fixture.ts'

const CLI = new URL('cli.ts', import.meta.url).pathname
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

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true })
})

describe('proof-bearing reclaim verbs', () => {
  test('worktree dry-run and reclaim require clean state and preserve its recorded identity', () => {
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

  test('worktree refusal names every uncommitted path', () => {
    const f = fixture()
    writeFileSync(join(f.tree, 'one.txt'), 'one\n')
    writeFileSync(join(f.tree, 'two.txt'), 'two\n')
    const result = orch(f.repo, ['reclaim', 'worktree', f.tree, '--dry-run'])
    expect(result.code).not.toBe(0)
    expect(result.err).toContain('uncommitted paths block reclaim: one.txt, two.txt')
    expect(existsSync(f.tree)).toBe(true)
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

  test('kept-tip proof belongs only to a run that minted the subject branch', () => {
    const f = fixture()
    writeFileSync(join(f.tree, 'unique.txt'), 'unique\n')
    git(f.tree, 'add', 'unique.txt')
    git(f.tree, 'commit', '-m', 'unique')
    const tip = git(f.tree, 'rev-parse', 'HEAD')
    git(f.repo, 'worktree', 'remove', '--force', f.tree)

    const unrelated = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: f.project })
    score(unrelated, 'full', 'right', 'faithful')
    db().query(
      'UPDATE run SET branch=?, minted_branch=?, branch_kept=?, branch_kept_tip=? WHERE id=?',
    ).run(f.branch, 'technical/DEV-391-different', f.branch, tip, unrelated)

    const result = orch(f.repo, ['reclaim', 'branch', `${f.project}:${f.branch}`])
    expect(git(f.repo, 'branch', '--list', f.branch)).toBe(f.branch)
    expect(git(f.repo, 'rev-parse', f.branch)).toBe(tip)
    expect(result.code).not.toBe(0)
    expect(result.err).toContain(`commits unreachable from landing branch main: ${tip}`)
  })

  test('branch reclaim refuses registered landing and production branches by name', () => {
    const f = fixture()
    upsertProject({
      name: f.project, path: f.repo,
      settings: { trunk: 'main', productionBranch: 'production' },
    })
    git(f.repo, 'branch', 'production', 'main')
    git(f.repo, 'switch', '--detach')

    const landing = orch(f.repo, ['reclaim', 'branch', `${f.project}:main`, '--dry-run'])
    expect(landing.code).not.toBe(0)
    expect(landing.err).toContain(`refused; branch ${f.project}:main is the registered landing branch`)

    const production = orch(f.repo, ['reclaim', 'branch', `${f.project}:production`, '--dry-run'])
    expect(production.code).not.toBe(0)
    expect(production.err).toContain(`refused; branch ${f.project}:production is the registered production branch`)
  })

  test('branch reclaim refuses when checked-out worktrees cannot be inspected', () => {
    const f = fixture()
    const bin = join(f.repo, 'failing-git')
    mkdirSync(bin)
    const realGit = Bun.spawnSync(['which', 'git']).stdout.toString().trim()
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$1 $2" = "worktree list" ]; then echo inspection-denied >&2; exit 128; fi\nexec "${realGit}" "$@"\n`)
    chmodSync(join(bin, 'git'), 0o755)

    const result = orch(
      f.repo,
      ['reclaim', 'branch', `${f.project}:${f.branch}`, '--dry-run'],
      { PATH: `${bin}:${process.env.PATH ?? ''}` },
    )
    expect(result.code).not.toBe(0)
    expect(result.err).toContain('refused; checked-out worktrees could not be inspected: inspection-denied')
  })

  test('worktree reclaim refuses a recorded directory that is not a registered git worktree', () => {
    const f = fixture()
    git(f.repo, 'worktree', 'remove', '--force', f.tree)
    mkdirSync(f.tree, { recursive: true })

    const result = orch(f.repo, ['reclaim', 'worktree', f.tree, '--dry-run'])
    expect(result.code).not.toBe(0)
    expect(result.err).toContain('refused; worktree safety could not be proved: not a registered git worktree')
    expect(existsSync(f.tree)).toBe(true)
  })

  test('worktree reclaim refuses the registered checkout by path', () => {
    const main = fixture()
    git(main.repo, 'worktree', 'remove', '--force', main.tree)
    const moved = `${main.repo}.reclaimed`
    repos.push(moved)
    upsertProject({
      name: main.project,
      path: main.repo,
      settings: {
        trunk: 'main',
        worktree: { remove: 'mv {path} {path}.reclaimed' },
      },
    })
    const registeredPath = realpathSync(main.repo)
    db().query(
      `UPDATE run SET worktree=?, cwd=?, branch='main', minted_branch=NULL,
                      worktree_source='recipe' WHERE id=?`,
    ).run(main.repo, main.repo, main.run)
    const registered = orch(main.repo, ['reclaim', 'worktree', main.repo])
    expect(existsSync(main.repo)).toBe(true)
    expect(existsSync(moved)).toBe(false)
    expect(registered.code).not.toBe(0)
    expect(registered.err).toContain(`refused; worktree ${registeredPath} is the project's registered checkout`)
  })

  test('worktree reclaim refuses a path outside the project worktrees directory', () => {
    const outside = fixture()
    const outsideTree = join(outside.repo, 'outside-worktree')
    git(outside.repo, 'worktree', 'move', outside.tree, outsideTree)
    db().query('UPDATE run SET worktree=?, cwd=? WHERE id=?').run(outsideTree, outsideTree, outside.run)
    const escaped = orch(outside.repo, ['reclaim', 'worktree', outsideTree])
    expect(existsSync(outsideTree)).toBe(true)
    expect(escaped.code).not.toBe(0)
    expect(escaped.err).toContain('is not beneath project worktrees directory')
  })

  test('sweep routes remembered trees through the containment proof', () => {
    const outside = fixture()
    const outsideTree = join(outside.repo, 'outside-sweep-worktree')
    git(outside.repo, 'worktree', 'move', outside.tree, outsideTree)
    db().query(
      "UPDATE run SET worktree=?, cwd=?, started_at=datetime('now', '-2 days') WHERE id=?",
    ).run(outsideTree, outsideTree, outside.run)
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000)
    for (const path of git(outsideTree, 'ls-files', '-co', '--exclude-standard').split('\n').filter(Boolean)) {
      utimesSync(join(outsideTree, path), old, old)
    }

    const swept = orch(outside.repo, ['sweep'])
    expect(existsSync(outsideTree)).toBe(true)
    expect(swept.code).toBe(0)
    expect(swept.out).toContain('is not beneath project worktrees directory')
  })

  test('branch reclaim refuses live ownership and a branch no run minted', () => {
    const live = fixture()
    git(live.repo, 'worktree', 'remove', '--force', live.tree)
    db().query("UPDATE run SET status='running', pid=? WHERE id=?").run(process.pid, live.run)
    const liveResult = orch(live.repo, ['reclaim', 'branch', `${live.project}:${live.branch}`, '--dry-run'])
    expect(liveResult.code).not.toBe(0)
    expect(liveResult.err).toContain(`refused; run ${live.run} worker pid ${process.pid} is live`)
    expect(git(live.repo, 'branch', '--list', live.branch)).toBe(live.branch)

    const unowned = fixture()
    git(unowned.repo, 'worktree', 'remove', '--force', unowned.tree)
    const branch = 'technical/DEV-391-unowned'
    git(unowned.repo, 'branch', branch, 'main')
    const unownedResult = orch(unowned.repo, ['reclaim', 'branch', `${unowned.project}:${branch}`, '--dry-run'])
    expect(unownedResult.code).not.toBe(0)
    expect(unownedResult.err).toContain(`refused; no run row records minted branch ${unowned.project}:${branch}`)
    expect(git(unowned.repo, 'branch', '--list', branch)).toBe(branch)
  })

  test('dry-run reclaim verbs create no lock or waiter state', () => {
    const f = fixture()
    const common = git(f.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    const lockState = () => readdirSync(common).filter((name) => name.startsWith('orch-')).sort()
    const beforeWorktree = lockState()
    const worktree = orch(f.repo, ['reclaim', 'worktree', f.tree, '--dry-run'])
    expect(worktree.code, worktree.err).toBe(0)
    expect(lockState()).toEqual(beforeWorktree)

    git(f.repo, 'worktree', 'remove', '--force', f.tree)
    const beforeBranch = lockState()
    const branch = orch(f.repo, ['reclaim', 'branch', `${f.project}:${f.branch}`, '--dry-run'])
    expect(branch.code, branch.err).toBe(0)
    expect(lockState()).toEqual(beforeBranch)
  })

  test('worktree reclaim honours keep_tree', () => {
    const f = fixture()
    db().query('UPDATE run SET keep_tree=1 WHERE id=?').run(f.run)

    const result = orch(f.repo, ['reclaim', 'worktree', f.tree, '--dry-run'])
    expect(result.code).not.toBe(0)
    expect(result.err).toContain(`refused; run ${f.run} records keep_tree; its worktree is protected`)
    expect(existsSync(f.tree)).toBe(true)
  })
})
