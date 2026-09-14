import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, readdirSync, statSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { db } from '../../src/db.ts'
import { writingFailoverRefusal } from '../../src/failover.ts'
import { JOBS } from '../../src/jobs.ts'
import { gitObjectEnvironmentFor, run as runJob } from '../../src/run.ts'
import { changesIn, createWorktree, prepareSharedRefGuard, removeFor } from '../../src/worktree.ts'
import { hermeticGitEnv } from '../fixtures/git.ts'
import { addRun, reapTestProcess } from '../fixtures/store.ts'
import { worktreeDescribeFixture } from '../fixtures/worktree.ts'

import { scriptedTransportSequence } from "../fake-transport.ts"
describe("a worktree is resolved against the main checkout, not the caller cwd", () => {
  const { git, scratchRepo, markScratchRepoOwner } = worktreeDescribeFixture()
  test('resumed child cleanup removes only the discarding run guard, not the marker owner guard', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-resumed-cleanup-'))
    const git = (args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(['add', 'base.txt']).exitCode).toBe(0)
      expect(git(['-c', 'user.email=orch-test@example.invalid', '-c', 'user.name=Orch Test',
        'commit', '-m', 'base']).exitCode).toBe(0)
      const root = 251
      const resumedChild = 252
      const tree = createWorktree(repo, root)
      const rootGuard = prepareSharedRefGuard(tree.path)
      const childGuard = join(realpathSync(repo), '.git', 'orch-guards', String(resumedChild))
      mkdirSync(childGuard)

      expect(removeFor(tree, repo, false, false, resumedChild).removed).toBe(true)
      expect(existsSync(rootGuard.GIT_CONFIG_VALUE_0)).toBe(true)
      expect(existsSync(childGuard)).toBe(false)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a resumed no-repository job still prepares the shared ref guard', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-no-repo-resume-'))
    const promptPath = join(repo, 'root.prompt.txt')
    const git = (args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'seed.txt'), 'seed\n')
      expect(git(['add', 'seed.txt']).exitCode).toBe(0)
      expect(git(['-c', 'user.name=Orch Test', '-c', 'user.email=orch@example.invalid',
        'commit', '-m', 'seed']).exitCode).toBe(0)
      const tree = createWorktree(repo, 462)
      const parent = addRun({ agent: 'codex', job: 'implement', status: 'asking' })
      writeFileSync(promptPath, 'original implementation spec')
      db().query('UPDATE run SET prompt_path=? WHERE id=?').run(promptPath, parent)
      scriptedTransportSequence([[{ kind: 'completed', output: 'summary' }]], (options) => {
        expect(options.gitConfigEnvironment?.GIT_CONFIG_VALUE_0).toBeTruthy()
        expect(existsSync(options.gitConfigEnvironment!.GIT_CONFIG_VALUE_0!)).toBe(true)
        const privateObjects = mkdtempSync(join(tmpdir(), 'orch-private-objects-'))
        const commonDir = Bun.spawnSync([
          'git', 'rev-parse', '--path-format=absolute', '--git-common-dir',
        ], { cwd: tree.path, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
        expect(commonDir.exitCode).toBe(0)
        const objectEnvironment = {
          GIT_OBJECT_DIRECTORY: privateObjects,
          GIT_ALTERNATE_OBJECT_DIRECTORIES: join(commonDir.stdout.toString().trim(), 'objects'),
        }
        try {
          const object = Bun.spawnSync(['git', 'commit-tree', 'HEAD^{tree}', '-m', 'private commit'], {
            cwd: tree.path, env: { ...hermeticGitEnv(), ...objectEnvironment },
            stdout: 'pipe', stderr: 'pipe',
          })
          expect(object.exitCode).toBe(0)
          const update = Bun.spawnSync([
            'git', 'update-ref', 'refs/heads/forbidden', object.stdout.toString().trim(),
          ], {
            cwd: tree.path,
            env: { ...hermeticGitEnv(), ...objectEnvironment, ...options.gitConfigEnvironment },
            stdout: 'pipe', stderr: 'pipe',
          })
          expect(update.exitCode).not.toBe(0)
          expect(update.stderr.toString()).toContain(
            'refusing shared ref update refs/heads/forbidden',
          )
        } finally {
          rmSync(privateObjects, { recursive: true, force: true })
        }
      }).install()
      const priorDepth = process.env.ORCH_DEPTH
      process.env.ORCH_DEPTH = '0'
      try {
        await runJob({
          job: 'summarize', prompt: 'summarize', cwd: tree.path, noFailover: true,
          resume: {
            parent, agent: 'codex', session: 'test-session', turn: 2,
            sessionId: 'orch-test-session', worktree: tree,
          },
        })
      } finally {
        if (priorDepth === undefined) delete process.env.ORCH_DEPTH
        else process.env.ORCH_DEPTH = priorDepth
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })


})

describe('shared ref guard publication boundary', () => {
test('a killed preparation never publishes a partial hooks directory', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-killed-publication-'))
    const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const projectHooks = join(repo, 'project-hooks')
      mkdirSync(projectHooks)
      const projectHook = join(projectHooks, 'reference-transaction')
      writeFileSync(projectHook, '#!/bin/sh\nexit 0\n')
      chmodSync(projectHook, 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      const module = new URL('../../src/worktree.ts', import.meta.url).href
      const checkpoints = ['mkdir', 'cleanup', 'temporary-open', 'write', 'chmod', 'fsync', 'close']
      for (const [index, checkpoint] of checkpoints.entries()) {
        const tree = createWorktree(repo, 231 + index)
        const hookDir = join(repo, '.git', 'orch-guards', String(231 + index))
        const ready = join(repo, `checkpoint-${checkpoint}`)
        const child = Bun.spawn([process.execPath, '-e',
          `const { registerStandardHooks } = await import(new URL('./store-hooks.ts', process.argv[1])); registerStandardHooks();
           const { prepareSharedRefGuard } = await import(process.argv[1]);
           prepareSharedRefGuard(process.argv[2], process.argv[3]);`,
          module, tree.path, `refs/heads/${tree.branch}`], {
          cwd: tree.path,
          env: hermeticGitEnv({
            ORCH_TEST_REF_GUARD_CHECKPOINT: checkpoint,
            ORCH_TEST_REF_GUARD_READY: ready,
          }),
          stdout: 'pipe', stderr: 'pipe',
        })
        try {
        // The loaded reproduction reached 4,983 ms. Three times that measured
        // worst case keeps this deadline a hang guard; the sentinel decides pass.
        const deadline = Date.now() + 3 * 4_983
        while (!existsSync(ready) && Date.now() < deadline) await Bun.sleep(5)
        expect(existsSync(ready)).toBe(true)
        expect(existsSync(hookDir)).toBe(false)
        child.kill('SIGKILL')
        expect(await child.exited).not.toBe(0)
        } finally {
          await reapTestProcess(child.pid)
        }

        const guardEnv = prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)
        const forbidden = git(tree.path, [
          'update-ref', 'refs/heads/forbidden', 'HEAD',
        ], guardEnv)
        expect(forbidden.exitCode).not.toBe(0)
        expect(forbidden.stderr.toString()).toContain('this worker may update only')
        expect(readdirSync(hookDir)).toEqual(['reference-transaction'])
        expect(readdirSync(join(repo, '.git', 'orch-guards'))
          .filter(name => name.startsWith('.orch-hooks-'))).toEqual([])
      }
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 120_000)

test('a wrapper delegating to a non-executable guard is rejected', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-broken-mode-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const projectHooks = join(repo, 'project-hooks')
      mkdirSync(projectHooks)
      const projectHook = join(projectHooks, 'reference-transaction')
      writeFileSync(projectHook, '#!/bin/sh\nexit 0\n')
      chmodSync(projectHook, 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      const tree = createWorktree(repo, 232)
      const guardEnv = prepareSharedRefGuard(tree.path)
      const installed = join(guardEnv.GIT_CONFIG_VALUE_0, 'reference-transaction')
      const runningGuard = realpathSync(new URL('../../hooks/reference-transaction', import.meta.url).pathname)
      const delegatedGuard = join(repo, 'delegated-guard')
      writeFileSync(delegatedGuard, readFileSync(runningGuard))
      chmodSync(delegatedGuard, 0o644)
      const wrapper = readFileSync(installed, 'utf8')
        .replace(Buffer.from(runningGuard).toString('base64'),
          Buffer.from(delegatedGuard).toString('base64'))
        .replace(`'${runningGuard}' "$@"`, `'${delegatedGuard}' "$@"`)
      writeFileSync(installed, wrapper)
      chmodSync(installed, 0o755)

      expect(() => prepareSharedRefGuard(tree.path)).toThrow(
        `refusing to replace existing shared ref guard hook ${installed}`,
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('concurrent shared-ref guard preparations publish one complete executable wrapper', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-concurrent-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const projectHooks = join(repo, 'project-hooks')
      mkdirSync(projectHooks)
      const projectHook = join(projectHooks, 'reference-transaction')
      writeFileSync(projectHook, '#!/bin/sh\nexit 0\n')
      chmodSync(projectHook, 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      const tree = createWorktree(repo, 233)
      const barrier = join(repo, 'start-preparation')
      const module = new URL('../../src/worktree.ts', import.meta.url).href
      const child = () => Bun.spawn([process.execPath, '-e',
        `import { existsSync } from 'node:fs';
         while (!existsSync(process.argv[2])) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
         const { prepareSharedRefGuard } = await import(process.argv[1]);
         prepareSharedRefGuard(process.argv[3]);`, module, barrier, tree.path], {
        cwd: tree.path, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      const first = child()
      const second = child()
      writeFileSync(barrier, 'go\n')
      const [firstExit, secondExit] = await Promise.all([first.exited, second.exited])
      expect(firstExit).toBe(0)
      expect(secondExit).toBe(0)
      const hookDir = join(repo, '.git', 'orch-guards', '233')
      const installed = join(hookDir, 'reference-transaction')
      expect(statSync(installed).mode & 0o111).toBe(0o111)
      expect(readdirSync(hookDir)).toEqual(['reference-transaction'])
      expect(readFileSync(installed, 'utf8')).toContain(
        Buffer.from(realpathSync(projectHook)).toString('base64'),
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  }, 15_000)

test('shared-ref guard refuses a self-referencing original without changing it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-self-reference-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const tree = createWorktree(repo, 226)
      const hookDir = join(realpathSync(repo), '.git', 'orch-guards', '226')
      const installed = join(hookDir, 'reference-transaction')
      mkdirSync(hookDir, { recursive: true })
      writeFileSync(installed, '#!/bin/sh\necho original\n')
      chmodSync(installed, 0o755)
      expect(git(tree.path, ['config', 'core.hooksPath', hookDir]).exitCode).toBe(0)
      const before = readFileSync(installed)

      expect(() => prepareSharedRefGuard(tree.path)).toThrow(
        `refusing shared ref guard wrapper: original hook resolves to its own path ${installed}`,
      )
      expect(readFileSync(installed)).toEqual(before)
      expect(readdirSync(hookDir)).toEqual(['reference-transaction'])
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('shared-ref guard refuses a project hook symlinked to the tracked guard', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-shared-symlink-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    const sharedGuard = realpathSync(new URL('../../hooks/reference-transaction', import.meta.url).pathname)
    const sharedBefore = readFileSync(sharedGuard)
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const tree = createWorktree(repo, 227)
      const projectHooks = join(repo, '.githooks')
      mkdirSync(projectHooks)
      symlinkSync(sharedGuard, join(projectHooks, 'reference-transaction'))
      expect(git(tree.path, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      const hookDir = join(realpathSync(repo), '.git', 'orch-guards', '227')

      expect(() => prepareSharedRefGuard(tree.path)).toThrow(
        `resolves to tracked shared guard ${sharedGuard}`,
      )
      expect(existsSync(hookDir)).toBe(false)
      expect(readFileSync(sharedGuard)).toEqual(sharedBefore)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('shared-ref guard refuses an unwritable hook path without cleaning it', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-guard-unwritable-'))
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    let hookDir: string | null = null
    try {
      expect(git(repo, ['init', '-b', 'main']).exitCode).toBe(0)
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      expect(git(repo, ['add', 'base.txt']).exitCode).toBe(0)
      expect(git(repo, ['-c', 'user.email=orch-test@example.invalid',
        '-c', 'user.name=Orch Test', 'commit', '-m', 'base']).exitCode).toBe(0)
      const tree = createWorktree(repo, 228)
      hookDir = join(realpathSync(repo), '.git', 'orch-guards', '228')
      mkdirSync(hookDir, { recursive: true })
      writeFileSync(join(hookDir, 'leave-alone'), 'sentinel\n')
      chmodSync(hookDir, 0o555)

      expect(() => prepareSharedRefGuard(tree.path)).toThrow(
        `cannot install shared ref guard: hook path is not writable: ${hookDir}`,
      )
      expect(readdirSync(hookDir)).toEqual(['leave-alone'])
      expect(readFileSync(join(hookDir, 'leave-alone'), 'utf8')).toBe('sentinel\n')
    } finally {
      if (hookDir) chmodSync(hookDir, 0o755)
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('the shared-ref guard permits real rebase and merge bookkeeping', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-worker-porcelain-'))
    const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
      })
    const ok = (cwd: string, args: string[], env: Record<string, string> = {}) => {
      const p = git(cwd, args, env)
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      ok(repo, ['init', '-b', 'main'])
      ok(repo, ['config', 'user.email', 'orch-test@example.invalid'])
      ok(repo, ['config', 'user.name', 'Orch Test'])
      writeFileSync(join(repo, 'base.txt'), 'base\n')
      ok(repo, ['add', 'base.txt'])
      ok(repo, ['commit', '-m', 'base'])

      const tree = createWorktree(repo, 199)
      const guard = prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)
      writeFileSync(join(tree.path, 'worker-one.txt'), 'worker one\n')
      ok(tree.path, ['add', 'worker-one.txt'], guard)
      ok(tree.path, ['commit', '-m', 'worker one'], guard)
      writeFileSync(join(repo, 'main-one.txt'), 'main one\n')
      ok(repo, ['add', 'main-one.txt'])
      ok(repo, ['commit', '-m', 'main one'])

      const rebased = git(tree.path, ['rebase', 'main'], guard)
      expect(rebased.exitCode).toBe(0)
      expect(rebased.stderr.toString()).not.toContain('refusing shared ref update')
      expect(ok(tree.path, ['merge-base', '--is-ancestor', 'main', 'HEAD'])).toBe('')

      writeFileSync(join(repo, 'main-two.txt'), 'main two\n')
      ok(repo, ['add', 'main-two.txt'])
      ok(repo, ['commit', '-m', 'main two'])
      writeFileSync(join(tree.path, 'worker-two.txt'), 'worker two\n')
      ok(tree.path, ['add', 'worker-two.txt'], guard)
      ok(tree.path, ['commit', '-m', 'worker two'], guard)

      const merged = git(tree.path, ['merge', '--no-edit', 'main'], guard)
      expect(merged.exitCode).toBe(0)
      expect(merged.stderr.toString()).not.toContain('refusing shared ref update')
      expect(ok(tree.path, ['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ')).toHaveLength(3)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('worker commits are durable while the guard protects every other ref', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-land-common-objects-'))
    const git = (cwd: string, args: string[], env: Record<string, string> = {}) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
      return p.stdout.toString().trim()
    }
    try {
      git(repo, ['init', '-b', 'main'])
      git(repo, ['config', 'user.email', 'orch-test@example.invalid'])
      git(repo, ['config', 'user.name', 'Orch Test'])
      writeFileSync(join(repo, 'kept.txt'), 'base\n')
      git(repo, ['add', 'kept.txt'])
      git(repo, ['commit', '-m', 'base'])

      // Prove the old environment can reproduce the incident: the landing
      // worktree reads its commit, while the checkout owning the common store
      // cannot. This is the ablation that makes the positive assertion useful.
      const isolatedTree = createWorktree(repo, 1490)
      const isolatedEnv = gitObjectEnvironmentFor('codex', JOBS['review-lens']!, isolatedTree)!
      writeFileSync(join(isolatedTree.path, 'private.txt'), 'private\n')
      git(isolatedTree.path, ['add', 'private.txt'], isolatedEnv)
      git(isolatedTree.path, ['commit', '-m', 'private commit'], isolatedEnv)
      const privateCommit = git(isolatedTree.path, ['rev-parse', 'HEAD'], isolatedEnv)
      expect(() => git(repo, ['cat-file', '-t', privateCommit])).toThrow()
      expect(existsSync(join(
        isolatedEnv.GIT_OBJECT_DIRECTORY, privateCommit.slice(0, 2), privateCommit.slice(2),
      ))).toBe(true)

      // Reproduce the dangerous operation itself. The proposed commit is
      // readable to this worktree only; the prepared reference transaction
      // must refuse before main changes, and diagnose both object and store.
      const guarded = Bun.spawnSync([
        'git', 'update-ref', 'refs/heads/main', privateCommit,
      ], {
        cwd: isolatedTree.path,
        env: hermeticGitEnv({ ...isolatedEnv, ...prepareSharedRefGuard(isolatedTree.path) }),
        stdout: 'pipe', stderr: 'pipe',
      })
      expect(guarded.exitCode).not.toBe(0)
      expect(guarded.stderr.toString()).toContain(`stranded object ${privateCommit}`)
      expect(guarded.stderr.toString()).toContain(isolatedEnv.GIT_OBJECT_DIRECTORY)
      expect(git(repo, ['rev-parse', 'main'])).not.toBe(privateCommit)

      // Remove the deliberately broken fixture before checking repository
      // connectivity for the fixed case.
      git(repo, ['worktree', 'remove', '--force', isolatedTree.path])
      git(repo, ['update-ref', '-d', `refs/heads/${isolatedTree.branch}`])

      const workerTree = createWorktree(repo, 1492)
      expect(gitObjectEnvironmentFor('codex', JOBS.implement!, workerTree)).toBeUndefined()
      writeFileSync(join(workerTree.path, 'worker.txt'), 'committed\n')
      git(workerTree.path, ['add', 'worker.txt'])
      const workerGuard = prepareSharedRefGuard(
        workerTree.path, `refs/heads/${workerTree.branch}`,
      )
      git(workerTree.path, ['commit', '-m', 'worker commit'], workerGuard)
      const workerCommit = git(workerTree.path, ['rev-parse', 'HEAD'])
      const captured = changesIn(workerTree)
      expect(captured.files).toEqual(['worker.txt'])
      expect(captured.diff).toContain('+committed')
      expect(writingFailoverRefusal(true, captured, workerTree.path)).toContain(
        'writing run has 1 changed file(s)',
      )

      const trunkAttempt = Bun.spawnSync([
        'git', 'update-ref', 'refs/heads/main', workerCommit,
      ], {
        cwd: workerTree.path,
        env: hermeticGitEnv(workerGuard), stdout: 'pipe', stderr: 'pipe',
      })
      expect(trunkAttempt.exitCode).not.toBe(0)
      expect(trunkAttempt.stderr.toString()).toContain(
        `refusing shared ref update refs/heads/main: this worker may update only ` +
        `refs/heads/${workerTree.branch}`,
      )
      expect(git(repo, ['rev-parse', 'main'])).not.toBe(workerCommit)

      git(repo, ['worktree', 'remove', '--force', workerTree.path])
      expect(git(repo, ['rev-parse', workerTree.branch])).toBe(workerCommit)
      expect(git(repo, ['cat-file', '-t', workerCommit])).toBe('commit')
      expect(() => git(repo, ['status', '--short'])).not.toThrow()
      expect(git(repo, ['fsck', '--connectivity-only'])).not.toContain(workerCommit)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

})
