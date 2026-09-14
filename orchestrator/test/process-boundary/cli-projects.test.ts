import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db } from '../../src/db.ts'
import { upsertProject } from '../../src/projects.ts'
import { runCollectionDescribeFixture } from '../fixtures/cli.ts'
import { cloneRepository, hermeticGitEnv } from '../fixtures/git.ts'
import { addRun } from '../fixtures/store.ts'


describe('project cleanup process boundary', () => {
  const { orch } = runCollectionDescribeFixture()
  const insert = (status: string, job = 'implement') =>
    addRun({ agent: 'codex', job, status, session: 'orch-test-session' })
test('discard removes both non-live worktrees owned by one chain', () => {
  const repo = cloneRepository('orch-discard-chain-trees-')
  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  try {
    const first = join(repo, 'first-tree')
    const second = join(repo, 'second-tree')
    git(repo, 'worktree', 'add', '-b', 'first-tree', first)
    git(repo, 'worktree', 'add', '-b', 'second-tree', second)
    upsertProject({ name: 'discard-chain-trees', path: repo, settings: { trunk: 'main' } })
    const root = addRun({ agent: 'codex', job: 'implement', status: 'ok', session: 'orch-test-session' })
    const child = addRun({ agent: 'codex', job: 'implement', status: 'failed', session: 'orch-test-session', parent: root, turn: 2 })
    db().query('UPDATE run SET repo=?,cwd=?,worktree=?,branch=?,base_commit=?,worktree_source=? WHERE id=?')
      .run('discard-chain-trees', first, first, 'first-tree', 'main', 'git', root)
    db().query('UPDATE run SET repo=?,cwd=?,worktree=?,branch=?,base_commit=?,worktree_source=? WHERE id=?')
      .run('discard-chain-trees', second, second, 'second-tree', 'main', 'git', child)
    const discarded = orch('discard', String(root), '--force')
    expect(discarded.code, discarded.err).toBe(0)
    expect(existsSync(first)).toBe(false)
    expect(existsSync(second)).toBe(false)
    expect(db().query('SELECT count(*) n FROM run WHERE worktree IS NOT NULL AND (id=? OR parent_run_id=?)')
      .get(root, root)).toEqual({ n: 0 })
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
  test('automatic abandon retains a branch recorded by another run', () => {
    const repo = cloneRepository('orch-abandon-')
    const git = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git('add', 'kept.txt')
      git('commit', '-m', 'base')
      git('branch', 'shared-branch')

      const abandoned = insert('asking', 'implement')
      const owner = insert('running', 'implement')
      const gone = join(repo, '.claude', 'worktrees', 'gone')
      db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
        .run(repo, gone, 'shared-branch', abandoned)
      db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, 'shared-branch', owner)

      const r = orch('abandon', String(abandoned))
      expect(r.code).toBe(0)
      expect(r.out).not.toContain('unscored')
      expect(git('branch', '--list', 'shared-branch')).toContain('shared-branch')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('automatic abandon ignores a same-named branch in another repository', () => {
    const first = cloneRepository('orch-abandon-first-')
    const second = cloneRepository('orch-abandon-second-')
    const git = (repo: string, ...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      for (const repo of [first, second]) {
        writeFileSync(join(repo, 'kept.txt'), 'base\n')
        git(repo, 'add', 'kept.txt')
        git(repo, 'commit', '-m', 'base')
        git(repo, 'branch', 'shared-branch')
      }
      upsertProject({ name: 'abandon-first', path: first })
      upsertProject({ name: 'abandon-second', path: second })
      const abandoned = insert('asking', 'implement')
      const otherRepository = insert('running', 'implement')
      db().query('UPDATE run SET repo=?, cwd=?, worktree=NULL, branch=? WHERE id=?')
        .run('abandon-first', first, 'shared-branch', abandoned)
      db().query('UPDATE run SET repo=?, cwd=?, branch=? WHERE id=?')
        .run('abandon-second', second, 'shared-branch', otherRepository)

      const r = orch('abandon', String(abandoned))
      expect(r.code).toBe(0)
      expect(r.out).not.toContain(`run ${otherRepository} records it`)
      expect(git(first, 'branch', '--list', 'shared-branch')).toBe('')
      expect(git(second, 'branch', '--list', 'shared-branch')).toContain('shared-branch')
    } finally {
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  })


})
