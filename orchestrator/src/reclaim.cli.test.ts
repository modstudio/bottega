import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

function orch(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, CLI, ...args], {
    cwd,
    env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
    stdout: 'pipe', stderr: 'pipe',
  })
  return { code: result.exitCode, out: result.stdout.toString(), err: result.stderr.toString() }
}

afterEach(() => {
  for (const repo of repos.splice(0)) rmSync(repo, { recursive: true, force: true })
})

describe('proof-bearing reclaim verbs', () => {
  test('worktree dry-run and reclaim require clean reachable state and clear the pointer', () => {
    const f = fixture()
    const preview = orch(f.repo, 'reclaim', 'worktree', f.tree, '--dry-run')
    expect(preview.code, preview.err).toBe(0)
    expect(preview.out).toContain('proved reconstructibility')
    expect(existsSync(f.tree)).toBe(true)

    const removed = orch(f.repo, 'reclaim', 'worktree', f.tree)
    expect(removed.code, removed.err).toBe(0)
    expect(existsSync(f.tree)).toBe(false)
    expect(db().query('SELECT worktree FROM run WHERE id=?').get(f.run)).toEqual({ worktree: null })
  })

  test('worktree refusal names every uncommitted path', () => {
    const f = fixture()
    writeFileSync(join(f.tree, 'one.txt'), 'one\n')
    writeFileSync(join(f.tree, 'two.txt'), 'two\n')
    const result = orch(f.repo, 'reclaim', 'worktree', f.tree, '--dry-run')
    expect(result.code).not.toBe(0)
    expect(result.err).toContain('uncommitted paths block reclaim: one.txt, two.txt')
    expect(existsSync(f.tree)).toBe(true)
  })

  test('branch refusal names unreachable commits and exact kept-tip proof permits deletion', () => {
    const f = fixture()
    writeFileSync(join(f.tree, 'unique.txt'), 'unique\n')
    git(f.tree, 'add', 'unique.txt')
    git(f.tree, 'commit', '-m', 'unique')
    const tip = git(f.tree, 'rev-parse', 'HEAD')
    git(f.repo, 'worktree', 'remove', '--force', f.tree)

    const refused = orch(f.repo, 'reclaim', 'branch', `${f.project}:${f.branch}`, '--dry-run')
    expect(refused.code).not.toBe(0)
    expect(refused.err).toContain(`commits unreachable from landing branch main: ${tip}`)

    db().query('UPDATE run SET branch_kept=?, branch_kept_tip=? WHERE id=?')
      .run(f.branch, tip, f.run)
    const removed = orch(f.repo, 'reclaim', 'branch', `${f.project}:${f.branch}`)
    expect(removed.code, removed.err).toBe(0)
    expect(git(f.repo, 'branch', '--list', f.branch)).toBe('')
  })
})
