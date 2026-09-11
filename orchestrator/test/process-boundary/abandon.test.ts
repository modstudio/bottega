/** Process boundary for abandon worktree cleanup. */
import { describe, expect, spyOn, test } from 'bun:test'
import { appendFileSync, chmodSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addRun, compoundCreate, createWithTool, createWorktree, db, declaredCreate, fakeDocker, fakeDockerCommand, hermeticGitCommand, hermeticGitEnv, nowIso, prepareSharedRefGuard, prepareWorktreeObjects, processStartTime, projectLockDir, reclaimStaleProjectLock, removeFor, resolveBase, runJob, staleProjectLockHolder, upsertProject, withProjectLock, withWorktreeCreateLock, worktreeDescribeFixture } from '../fixture.ts'
import { scriptedTransportSequence } from '../fake-transport.ts'


describe("a worktree is resolved against the main checkout, not the caller cwd", () => {
  const { git, scratchRepo, markScratchRepoOwner } = worktreeDescribeFixture()
  test('abandon cleans an absent worktree identity through project removal', () => {
    const { repo } = scratchRepo()
    const id = addRun({
      agent: 'codex', job: 'implement', status: 'asking', repo: 'gone-tree-tool',
    })
    const gone = join(repo, '.claude', 'worktrees', `orch-${id}`)
    const called = join(repo, 'remove-called')
    upsertProject({
      name: 'gone-tree-tool', path: realpathSync(repo),
      settings: {
        trunk: 'main', worktree: { remove: `printf removed > "${called}"` },
      },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, gone, `orch/${id}`, `orch/${id}`, id)
    const docker = fakeDocker([], [])
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(existsSync(called)).toBe(true)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('abandon keeps a branch with an unmerged commit', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 886)
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    upsertProject({ name: 'abandon-trunk', path: realpathSync(repo), settings: { trunk: 'main' } })
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toContain(tree.branch)
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: tree.branch })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('automatic abandon without a configured trunk removes a disposable branch', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 888)
    upsertProject({ name: 'no-trunk-abandon', path: realpathSync(repo), settings: {} })
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).not.toContain('kept branch')
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })


})
