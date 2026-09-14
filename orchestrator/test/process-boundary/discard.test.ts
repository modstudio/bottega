/** Process boundary for discard branch and worktree cleanup. */
import { describe, expect, spyOn, test } from 'bun:test'
import { appendFileSync, chmodSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { db, nowIso } from '../../src/db.ts'
import { prepareWorktreeObjects } from '../../src/git-environment.ts'
import { upsertProject } from '../../src/projects.ts'
import { run as runJob } from '../../src/run.ts'
import { createWithTool, createWorktree, prepareSharedRefGuard, processStartTime, projectLockDir, reclaimStaleProjectLock, removeFor, resolveBase, staleProjectLockHolder, withProjectLock, withWorktreeCreateLock } from '../../src/worktree.ts'
import { fakeDocker, fakeDockerCommand } from '../fixtures/docker.ts'
import { hermeticGitCommand, hermeticGitEnv } from '../fixtures/git.ts'
import { addRun } from '../fixtures/store.ts'
import { compoundCreate, declaredCreate, worktreeDescribeFixture } from '../fixtures/worktree.ts'

import { scriptedTransportSequence } from '../fake-transport.ts'


describe("a worktree is resolved against the main checkout, not the caller cwd", () => {
  const { git, scratchRepo, markScratchRepoOwner } = worktreeDescribeFixture()
  test('discard --force does not override a project tool for a tree orch did not create', () => {
    const { repo } = scratchRepo()
    const path = join(repo, '.claude', 'worktrees', 'operator-tree')
    git(repo, 'worktree', 'add', '-b', 'operator-tree', path, 'main')
    writeFileSync(join(path, 'operator.txt'), 'protected work\n')
    upsertProject({
      name: 'refusing-operator-tool', path: realpathSync(repo),
      settings: { worktree: { remove: "echo 'protected operator work' >&2; exit 7" } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
      .run(path, 'operator-tree', id)
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id), '--force'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain('protected operator work')
      expect(p.stderr.toString()).toContain(
        "--force will not override a project tool's refusal unless the tree carries orch's " +
        '.orch-run ownership marker',
      )
      expect(existsSync(path)).toBe(true)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard --force removes a dirty orch-created tree after its project tool refuses', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 889)
    writeFileSync(join(tree.path, 'scratch.txt'), 'worker scratch state\n')
    upsertProject({
      name: 'refusing-orch-tool', path: realpathSync(repo),
      settings: { worktree: { remove: "echo 'dirty tree refused' >&2; exit 7" } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id), '--force'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard on an unregistered repository uses git removal', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 882)
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const env = { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
        CLAUDE_CODE_SESSION_ID: 'discard-actor' }
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env, stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query(
        'SELECT action, actor_session FROM run_mutation_audit WHERE run_id=? ORDER BY rowid',
      ).all(id)).toEqual([
        { action: 'adopt', actor_session: 'discard-actor' },
        { action: 'discard', actor_session: 'discard-actor' },
      ])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard keeps a branch with an unmerged commit and records it', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 883)
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    const tip = git(tree.path, 'rev-parse', 'HEAD')
    const script = join(repo, 'remove-and-delete.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: 'protected-tool', path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET repo=?, cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run('protected-tool', repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain(
        `kept branch ${tree.branch}: 1 commit(s) reachable only from this branch — merge it, or ` +
        `orch discard ${id} --force to delete it after checking no other run owns it`,
      )
      expect(existsSync(tree.path)).toBe(false)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: tree.branch })

      const owner = addRun({
        agent: 'codex', job: 'implement', status: 'running', repo: 'protected-tool',
      })
      db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, tree.branch, owner)
      const refused = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(id), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(refused.exitCode).not.toBe(0)
      expect(refused.stderr.toString()).toContain(
        `branch ${tree.branch} is still evidence owned by run ${owner}`,
      )
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      db().query('UPDATE run SET branch=NULL WHERE id=?').run(owner)

      const forced = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(id), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(forced.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 20_000)

  test('discard --force deletes a branch with an unmerged commit', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 884)
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id), '--force'], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard never rewinds a protected branch moved by the project remove tool', () => {
    const { repo } = scratchRepo()
    const project = `moved-protected-${repo.split('/').pop()}`
    const id = addRun({ agent: 'codex', job: 'implement', repo: project })
    const tree = createWorktree(repo, id)
    writeFileSync(join(tree.path, 'unique.txt'), 'first tip\n')
    git(tree.path, 'add', 'unique.txt')
    git(tree.path, 'commit', '-m', 'first unique tip')
    const first = git(tree.path, 'rev-parse', 'HEAD')
    git(repo, 'checkout', '-b', 'fixture-later-tip', first)
    writeFileSync(join(repo, 'later.txt'), 'later tip\n')
    git(repo, 'add', 'later.txt')
    git(repo, 'commit', '-m', 'later unique tip')
    const later = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'checkout', 'main')
    git(repo, 'branch', '-D', 'fixture-later-tip')
    const script = join(repo, 'move-protected-branch.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      `git update-ref "refs/heads/$2" "${later}"\n`)
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain(
        `protected branch ${tree.branch} moved from ${first} to ${later}`,
      )
      expect(p.stderr.toString()).toContain(`left at ${later}`)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(later)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree.path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard deletes a branch whose commit is merged into trunk', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 885)
    writeFileSync(join(tree.path, 'merged.txt'), 'merged work\n')
    git(tree.path, 'add', 'merged.txt')
    git(tree.path, 'commit', '-m', 'merged work')
    git(repo, 'merge', '--ff-only', tree.branch)
    upsertProject({ name: 'merged-trunk', path: realpathSync(repo), settings: { trunk: 'main' } })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard without a configured trunk still deletes a branch with no unique commits', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 887)
    upsertProject({ name: 'no-trunk-discard', path: realpathSync(repo), settings: {} })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
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

  test('discard does not keep a branch merely ahead of a stale local trunk', () => {
    const { repo } = scratchRepo()
    writeFileSync(join(repo, 'upstream.txt'), 'upstream\n')
    git(repo, 'add', 'upstream.txt')
    git(repo, 'commit', '-m', 'upstream')
    const originTip = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/remotes/origin/main', originTip)
    git(repo, 'reset', '--hard', 'HEAD~1')
    upsertProject({
      name: 'stale-trunk', path: realpathSync(repo), settings: { trunk: 'main' },
    })
    const tree = createWorktree(repo, 890, 'origin/main')
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, tree.base, id)
    try {
      expect(git(repo, 'rev-list', '--count', `main..${tree.branch}`)).not.toBe('0')
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
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

  test('discard still keeps unique commits when the local trunk is stale', () => {
    const { repo } = scratchRepo()
    writeFileSync(join(repo, 'upstream.txt'), 'upstream\n')
    git(repo, 'add', 'upstream.txt')
    git(repo, 'commit', '-m', 'upstream')
    const originTip = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/remotes/origin/main', originTip)
    git(repo, 'reset', '--hard', 'HEAD~1')
    upsertProject({
      name: 'stale-trunk-unique', path: realpathSync(repo), settings: { trunk: 'main' },
    })
    const tree = createWorktree(repo, 891, 'origin/main')
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    const tip = git(tree.path, 'rev-parse', 'HEAD')
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=?, base_commit=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, tree.base, id)
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain(
        `kept branch ${tree.branch}: deleting it would lose commits reachable from no other ref; ` +
        `1 commit(s) after the cut`,
      )
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: tree.branch })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })


})
