import { describe, expect, test } from 'bun:test'
import { rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { addRun, createWithTool, createWorktree, db, fakeDocker, fakeDockerCommand, hermeticGitCommand, nowIso, prepareSharedRefGuard, prepareWorktreeObjects, unmergedBranch, upsertProject } from '../test/fixture.ts'

import { worktreeDescribeFixture } from '../test/fixture.ts'

describe("a worktree is resolved against the main checkout, not the caller cwd", () => {
  const { git, scratchRepo } = worktreeDescribeFixture()
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
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, target)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, tree.branch, owner)
    const docker = fakeDocker([`orch-${target}-leaked`], [])
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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

  test('an unscored failed run owns its recorded branch', () => {
    const { repo } = scratchRepo()
    const project = `unscored-ref-${repo.split('/').pop()}`
    const target = addRun({ agent: 'codex', job: 'implement', status: 'ok', repo: project })
    const owner = addRun({ agent: 'codex', job: 'implement', status: 'failed', repo: project })
    const tree = createWorktree(repo, target)
    writeFileSync(join(tree.path, 'unlanded.txt'), 'not on trunk\n')
    git(tree.path, 'add', 'unlanded.txt')
    git(tree.path, 'commit', '-m', 'fixture: unlanded work')
    const tip = git(repo, 'rev-parse', tree.branch)
    const script = join(repo, 'delete-unscored-owner-branch.sh')
    writeFileSync(script,
      'git worktree remove --force "$1"\n' +
      'git branch -D "$2"\n')
    upsertProject({
      name: project, path: realpathSync(repo),
      settings: { trunk: 'main', worktree: { remove: `sh "${script}" {path} {branch}` } },
    })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, target)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, tree.branch, owner)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync(
        [process.execPath, CLI, 'discard', String(target), '--force'],
        {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        },
      )
      expect(p.exitCode).toBe(0)
      expect(p.stderr.toString()).toContain(`deleted shared branch ${tree.branch}`)
      expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(target))
        .toEqual({ worktree: null })
    } finally {
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
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, target)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, tree.branch, owner)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, target)
    db().query('UPDATE run SET cwd=?, branch=? WHERE id=?').run(repo, tree.branch, owner)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    const docker = fakeDocker(
      [`orch-${id}-postgres-1`, 'unrelated-container'],
      [`orch-${id}_adanim-pgdata`, 'unrelated-volume'],
    )
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    const docker = fakeDockerCommand("echo 'docker unavailable' >&2; exit 127")
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    const docker = fakeDockerCommand('sleep 5')
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const started = Date.now()
      const p = Bun.spawnSync([process.execPath, CLI, 'discard', String(id)], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(Date.now() - started).toBeLessThan(3_000)
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

  test('abandon invokes the project remove tool even when the worktree directory is already gone', () => {
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
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, gone, `orch/${id}`, id)
    const docker = fakeDocker([], [])
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ...docker.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(readFileSync(called, 'utf8')).toBe('removed')
      expect(db().query('SELECT worktree FROM run WHERE id=?').get(id))
        .toEqual({ worktree: null })
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(docker.dir, { recursive: true, force: true })
    }
  })

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
      const CLI = new URL('cli.ts', import.meta.url).pathname
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
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
      .run(tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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
    db().query('UPDATE run SET worktree=?, branch=? WHERE id=?')
      .run(tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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
    db().query('UPDATE run SET repo=?, cwd=?, worktree=?, branch=? WHERE id=?')
      .run('protected-tool', repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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

  test('abandon keeps a branch with an unmerged commit', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 886)
    writeFileSync(join(tree.path, 'architect.txt'), 'work in progress\n')
    git(tree.path, 'add', 'architect.txt')
    git(tree.path, 'commit', '-m', 'architect work')
    upsertProject({ name: 'abandon-trunk', path: realpathSync(repo), settings: { trunk: 'main' } })
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
      const p = Bun.spawnSync([process.execPath, CLI, 'abandon', String(id)], {
        env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(p.exitCode).toBe(0)
      expect(p.stdout.toString()).toContain(
        `kept branch ${tree.branch}: 1 commit(s) reachable only from this branch — merge it, or ` +
        `orch discard ${id} --force to delete it`,
      )
      expect(git(repo, 'branch', '--list', tree.branch)).toContain(tree.branch)
      expect(db().query('SELECT branch_kept FROM run WHERE id=?').get(id))
        .toEqual({ branch_kept: tree.branch })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  for (const cleanup of ['abandon', 'sweep'] as const) {
    test(`${cleanup} keeps a cut commit after trunk is rewound away from it`, () => {
      const { repo } = scratchRepo()
      const project = `rewound-cut-${cleanup}-${repo.split('/').pop()}`
      writeFileSync(join(repo, 'cut.txt'), 'recorded cut\n')
      git(repo, 'add', 'cut.txt')
      git(repo, 'commit', '-m', 'recorded cut')
      const id = addRun({
        agent: 'codex', job: 'implement', status: cleanup === 'abandon' ? 'asking' : 'ok',
        repo: project,
      })
      const tree = createWorktree(repo, id)
      const tip = git(repo, 'rev-parse', tree.branch)
      git(repo, 'worktree', 'remove', '--force', tree.path)
      git(repo, 'reset', '--hard', 'HEAD~1')
      upsertProject({ name: project, path: realpathSync(repo), settings: { trunk: 'main' } })
      db().query(
        `UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=?, started_at=? WHERE id=?`,
      ).run(repo, tree.path, tree.branch, tip, '2020-01-01T00:00:00.000Z', id)
      if (cleanup === 'sweep') {
        db().query(
          `INSERT INTO score (run_id, delivery, quality, fidelity, scored_at)
           VALUES (?,'full','right','faithful',?)`,
        ).run(id, nowIso())
      }
      try {
        const CLI = new URL('cli.ts', import.meta.url).pathname
        const args = cleanup === 'abandon'
          ? ['abandon', String(id)]
          : ['sweep', '--older-than', '0']
        const p = Bun.spawnSync([process.execPath, CLI, ...args], {
          env: { ...process.env, ORCH_DB: process.env.ORCH_DB!, ORCH_DEPTH: '0' },
          stdout: 'pipe', stderr: 'pipe',
        })
        expect(p.exitCode).toBe(0)
        expect(git(repo, 'rev-parse', tree.branch)).toBe(tip)
        expect(p.stdout.toString()).toContain(`kept branch ${tree.branch}`)
        expect(p.stdout.toString()).toContain('0 commit(s) after the cut')
        expect(db().query('SELECT worktree, branch_kept FROM run WHERE id=?').get(id))
          .toEqual({ worktree: null, branch_kept: tree.branch })
      } finally {
        rmSync(repo, { recursive: true, force: true })
      }
    })
  }

  test('discard without a configured trunk still deletes a branch with no unique commits', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 887)
    upsertProject({ name: 'no-trunk-discard', path: realpathSync(repo), settings: {} })
    const id = addRun({ agent: 'codex', job: 'implement' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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

  test('abandon without a configured trunk still deletes a branch with no unique commits', () => {
    const { repo } = scratchRepo()
    const tree = createWorktree(repo, 888)
    upsertProject({ name: 'no-trunk-abandon', path: realpathSync(repo), settings: {} })
    const id = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
    db().query('UPDATE run SET cwd=?, worktree=?, branch=? WHERE id=?')
      .run(repo, tree.path, tree.branch, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.base, id)
    try {
      expect(git(repo, 'rev-list', '--count', `main..${tree.branch}`)).not.toBe('0')
      const CLI = new URL('cli.ts', import.meta.url).pathname
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
    db().query('UPDATE run SET cwd=?, worktree=?, branch=?, base_commit=? WHERE id=?')
      .run(repo, tree.path, tree.branch, tree.base, id)
    try {
      const CLI = new URL('cli.ts', import.meta.url).pathname
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

  test('unmergedBranch counts only commits reachable from nowhere else', () => {
    const { repo } = scratchRepo()
    writeFileSync(join(repo, 'upstream.txt'), 'upstream\n')
    git(repo, 'add', 'upstream.txt')
    git(repo, 'commit', '-m', 'upstream')
    const originTip = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'update-ref', 'refs/remotes/origin/main', originTip)
    git(repo, 'reset', '--hard', 'HEAD~1')
    const tree = createWorktree(repo, 892, 'origin/main')
    try {
      expect(unmergedBranch(repo, tree.branch, tree.base)).toBe(null)
      expect(unmergedBranch(repo, tree.branch, null)).toBe(null)
      writeFileSync(join(tree.path, 'unique.txt'), 'only here\n')
      git(tree.path, 'add', 'unique.txt')
      git(tree.path, 'commit', '-m', 'unique')
      const tip = git(tree.path, 'rev-parse', 'HEAD')
      expect(unmergedBranch(repo, tree.branch, tree.base)).toEqual({ count: 1, tip })
      expect(unmergedBranch(repo, tree.branch, null)).toEqual({ count: 1, tip })
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('recipe failure runs its declared stop before removing the tree', () => {
    const { repo } = scratchRepo()
    const stopped = join(repo, 'recipe-stopped.txt')
    const tool = {
      recipe: {
        serve: 'serve --port {port}',
        stop: `printf stopped > "${stopped}"`,
        after: 'exit 9',
      },
    }
    upsertProject({
      name: 'recipe-project', path: realpathSync(repo), settings: { worktree: tool },
    })
    try {
      expect(() => createWithTool(tool, repo, 883)).toThrow('worktree setup failed at "after"')
      expect(readFileSync(stopped, 'utf8')).toBe('stopped')
      expect(existsSync(join(repo, '.claude', 'worktrees', 'orch-883'))).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})
