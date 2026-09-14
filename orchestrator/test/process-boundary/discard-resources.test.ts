/** Process boundary for discard resource inventory and recovery. */
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
test('discard inventories leaks after successfully restoring a shared branch', () => {
    const { repo } = scratchRepo()
    const project = `restored-leak-${repo.split('/').pop()}`
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const tree = createWorktree(repo, target)
    const tip = git(repo, 'rev-parse', tree.branch)
    const script = join(repo, 'delete-shared-but-leak.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, target)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, tree.branch, owner)
    const docker = fakeDocker([`orch-${target}-leaked`], [])
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(target), '--force'],
        {
          env: {
            ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const error = p.stderr.toString()
      expect(p.exitCode).not.toBe(0)
      expect(error).toContain(`deleted shared branch ${tree.branch}; restored ${tip}`)
      expect(error).toContain(`container orch-${target}-leaked leaked by project ${project}`)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(target))
        .toEqual({ worktree: tree.path })
    } finally {
      rmSync(docker.dir, { recursive: true, force: true })
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard targets the project repository under a managed-worker Git environment', () => {
    const { repo } = scratchRepo()
    const { repo: workerRepo } = scratchRepo()
    const worker = createWorktree(workerRepo, 1701)
    const managedEnv = {
      ...prepareWorktreeObjects(worker.path),
      ...prepareSharedRefGuard(worker.path, `refs/heads/${worker.branch}`),
    }
    const project = `managed-cleanup-${repo.split('/').pop()}`
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const tree = createWorktree(repo, target)
    const tip = git(repo, 'rev-parse', tree.branch)
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: {
        trunk: 'main',
        worktree: {
          remove: `${hermeticGitCommand} worktree remove --force {path}; ` +
            `${hermeticGitCommand} branch -D {branch}`,
        },
      },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, target)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, tree.branch, owner)
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(target), '--force'],
        {
          env: {
            ...process.env, ...managedEnv, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0',
          },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(p.exitCode).toBe(0)
      expect(p.stderr.toString()).toContain(`deleted shared branch ${tree.branch}`)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(p.stderr.toString()).not.toContain('nonexistent object')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(workerRepo, { recursive: true, force: true })
    }
  })

  test('a refused branch restore records and publishes its recovery tip', () => {
    const { repo } = scratchRepo()
    const project = `refused-restore-${repo.split('/').pop()}`
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const owner = addRun({ agent: 'codex', job: 'implement', status: 'running', repo: project })
    const tree = createWorktree(repo, target)
    const tip = git(repo, 'rev-parse', tree.branch)
    const hooks = join(repo, 'refusing-hooks')
    mkdirSync(hooks)
    const hook = join(hooks, 'reference-transaction')
    writeFileSync(hook,
      '#!/bin/sh\n' +
      'zero=0000000000000000000000000000000000000000\n' +
      'while read old new ref; do [ "$old" = "$zero" ] && exit 1; done\n' +
      'exit 0\n')
    chmodSync(hook, 0o755)
    const script = join(repo, 'delete-before-refused-restore.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n' +
      `git config core.hooksPath "${hooks}"\n`)
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, target)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, tree.branch, owner)
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(target), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      const error = p.stderr.toString()
      expect(p.exitCode).not.toBe(0)
      expect(error).toContain(`branch ${tree.branch} should have been restored to ${tip}`)
      expect(error).toContain('ref write was refused')
      expect(error).toContain('Restore it from the main checkout.')
      expect(git(repo, 'branch', '--list', tree.branch)).toBe('')
      expect(db().query('SELECT branch_kept, branch_kept_tip FROM run WHERE id=?').get(target))
        .toEqual({ branch_kept: tree.branch, branch_kept_tip: tip })
      const shown = Bun.spawnSync([process.execPath, CLI, 'run', String(target)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(shown.exitCode).toBe(0)
      expect(JSON.parse(shown.stdout.toString())).toMatchObject({
        branch_kept: tree.branch, branch_kept_tip: tip,
      })
    } finally {
      git(repo, 'config', '--unset', 'core.hooksPath')
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('discard reports Docker resources left by a successful project remove and keeps the pointer', () => {
    const { repo } = scratchRepo()
    const id = addRun({ agent: 'codex', job: 'implement', repo: 'leaking-tool' })
    const tree = {
      path: join(repo, '.claude', 'worktrees', `DEV-207-orch-${id}`),
      branch: `orch/${id}`,
      mintedBranch: `orch/${id}`,
    }
    git(repo, 'worktree', 'add', '-b', tree.branch, tree.path, 'main')
    const script = join(repo, 'remove-but-leak.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: 'leaking-tool', path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    const docker = fakeDocker(
      [`orch-${id}-postgres-1`, 'unrelated-container'],
      [`orch-${id}_adanim-pgdata`, 'unrelated-volume'],
    )
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain(`container orch-${id}-postgres-1 leaked by project leaking-tool`)
      expect(p.stderr.toString()).toContain(`volume orch-${id}_adanim-pgdata leaked by project leaking-tool`)
      expect(p.stderr.toString()).not.toContain('unrelated-container')
      expect(existsSync(tree.path)).toBe(false)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree.path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('discard refuses unverifiable cleanup when Docker inventory is unavailable', () => {
    const { repo } = scratchRepo()
    const id = addRun({ agent: 'codex', job: 'implement', repo: 'inventory-tool' })
    const tree = createWorktree(repo, id)
    const script = join(repo, 'remove-before-inventory.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: 'inventory-tool', path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    const docker = fakeDockerCommand("echo 'docker unavailable' >&2; exit 127")
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain('inventory unavailable')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree.path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

  test('discard bounds an unresponsive Docker inventory and keeps the pointer', () => {
    const { repo } = scratchRepo()
    const id = addRun({ agent: 'codex', job: 'implement', repo: 'slow-inventory-tool' })
    const tree = createWorktree(repo, id)
    const script = join(repo, 'remove-before-slow-inventory.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: 'slow-inventory-tool', path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, minted_branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.mintedBranch ?? tree.branch, id)
    const docker = fakeDockerCommand('sleep 5')
    try {
      const CLI = new URL('../../src/orch.ts', import.meta.url).pathname
      const started = Date.now()
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      // The bound derives from the inventory timeout the shard runner hands
      // this file (run-gate sets it per size class), not from a quiet-machine
      // literal: discard takes two bounded inventory calls (containers, then
      // volumes), so it must return within twice that timeout plus overhead.
      const inventoryMs = Number(process.env.ORCH_DOCKER_INVENTORY_TIMEOUT_MS ?? 1000)
      expect(Date.now() - started).toBeLessThan(inventoryMs * 2 + 2_000)
      expect(p.exitCode).not.toBe(0)
      expect(p.stderr.toString()).toContain('inventory unavailable')
      expect(p.stderr.toString()).toContain('timed out')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: tree.path })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  }, 15_000)


})
