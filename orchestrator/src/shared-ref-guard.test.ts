import { expect, test, describe } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, realpathSync, mkdirSync, chmodSync, readdirSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'
import { addRun } from '../test/fixtures/store.ts'
import { prepareWorktreeObjects } from './git-environment.ts'
import { assertSharedRefGuardOutsideWritableRoots, createWorktree, prepareSharedRefGuard, removeFor, removeSharedRefGuard } from './worktree.ts'
test('the shared-ref guard does not run project hooks in a scratch repository', () => {
    const repo = cloneRepository('orch-project-hooks-')
    const scratch = cloneRepository('orch-unrelated-scratch-')
    const cleanConfig = { GIT_CONFIG_COUNT: '0' }
    const git = (cwd: string, args: string[], env: Record<string, string> = cleanConfig) =>
      Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
      })
    try {
      const projectHooks = join(repo, '.githooks')
      const actualProjectHooks = join(repo, '.actual-hooks')
      mkdirSync(projectHooks)
      mkdirSync(actualProjectHooks)
      writeFileSync(join(projectHooks, 'commit-msg'), '#!/bin/sh\nexit 1\n')
      chmodSync(join(projectHooks, 'commit-msg'), 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      const tree = createWorktree(repo, 156)
      const actualReferenceHook = join(actualProjectHooks, 'reference-transaction')
      writeFileSync(actualReferenceHook, '#!/bin/sh\nexit 1\n')
      chmodSync(actualReferenceHook, 0o755)
      symlinkSync(actualReferenceHook, join(projectHooks, 'reference-transaction'))

      const guardEnv = prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)
      expect(guardEnv.GIT_CONFIG_VALUE_0).toBe(join(realpathSync(repo), '.git', 'orch-guards', '156'))
      expect(readdirSync(guardEnv.GIT_CONFIG_VALUE_0))
        .toEqual(['reference-transaction'])
      const installedWrapper = readFileSync(
        join(guardEnv.GIT_CONFIG_VALUE_0, 'reference-transaction'), 'utf8',
      )
      expect(installedWrapper).toContain(Buffer.from(realpathSync(actualReferenceHook)).toString('base64'))
      expect(installedWrapper).not.toContain(Buffer.from(
        join(projectHooks, 'reference-transaction'),
      ).toString('base64'))
      const installedReferenceHook = join(
        guardEnv.GIT_CONFIG_VALUE_0, 'reference-transaction',
      )
      expect(installedWrapper).not.toContain(
        `'${installedReferenceHook}' "$@"`,
      )
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
      process.env.GIT_CONFIG_VALUE_0 = guardEnv.GIT_CONFIG_VALUE_0
      try {
        expect(prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)).toEqual(guardEnv)
      } finally {
        delete process.env.GIT_CONFIG_COUNT
        delete process.env.GIT_CONFIG_KEY_0
        delete process.env.GIT_CONFIG_VALUE_0
      }
      expect(readFileSync(
        join(guardEnv.GIT_CONFIG_VALUE_0, 'reference-transaction'), 'utf8',
      )).toBe(installedWrapper)

      expect(git(scratch, ['init', '-b', 'main'], guardEnv).exitCode).toBe(0)
      expect(git(scratch, ['config', 'user.email', 'orch-test@example.invalid'], guardEnv).exitCode).toBe(0)
      expect(git(scratch, ['config', 'user.name', 'Orch Test'], guardEnv).exitCode).toBe(0)
      writeFileSync(join(scratch, 'fixture.txt'), 'fixture\n')
      expect(git(scratch, ['add', 'fixture.txt'], guardEnv).exitCode).toBe(0)
      const committed = git(scratch, ['commit', '-m', 'test fixture'], guardEnv)
      expect(committed.exitCode).toBe(0)
      expect(committed.stderr.toString()).toBe('')

      const scratchTree = createWorktree(scratch, 165)
      const scratchObjects = prepareWorktreeObjects(scratchTree.path)
      writeFileSync(join(scratchTree.path, 'private.txt'), 'scratch-private\n')
      expect(git(scratchTree.path, ['add', 'private.txt'], {
        ...guardEnv, ...scratchObjects,
      }).exitCode).toBe(0)
      const privateCommit = git(scratchTree.path, ['commit', '-m', 'private fixture'], {
        ...guardEnv, ...scratchObjects,
      })
      expect(privateCommit.exitCode).toBe(0)
      expect(privateCommit.stderr.toString()).toBe('')
      const privateOid = git(scratchTree.path, ['rev-parse', 'HEAD'], scratchObjects)
        .stdout.toString().trim()
      expect(existsSync(join(
        scratchObjects.GIT_OBJECT_DIRECTORY, privateOid.slice(0, 2), privateOid.slice(2),
      ))).toBe(true)
      expect(existsSync(join(
        scratch, '.git', 'objects', privateOid.slice(0, 2), privateOid.slice(2),
      ))).toBe(false)
      const updated = git(scratchTree.path, [
        'update-ref', 'refs/heads/scratch-private', privateOid,
      ], { ...guardEnv, ...scratchObjects })
      expect(updated.exitCode).toBe(0)
      expect(updated.stderr.toString()).toBe('')
    } finally {
      rmSync(repo, { recursive: true, force: true })
      rmSync(scratch, { recursive: true, force: true })
    }
  })

  test('dispatch containment refuses a guard inside a writable root and names the invariant', () => {
    const root = mkdtempSync(join(tmpdir(), 'orch-guard-contained-'))
    const guard = join(root, 'orch-guards', '248')
    try {
      mkdirSync(guard, { recursive: true })
      expect(() => assertSharedRefGuardOutsideWritableRoots(guard, [root])).toThrow(
        'THE GUARD LIVES OUTSIDE EVERY ROOT THE WORKER CAN WRITE invariant failed',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('shared-ref guard teardown removes the run directory and accepts it already missing', () => {
    const repo = cloneRepository('orch-guard-teardown-')
    try {
      const tree = createWorktree(repo, 248)
      const guard = prepareSharedRefGuard(tree.path)
      expect(existsSync(guard.GIT_CONFIG_VALUE_0)).toBe(true)
      expect(removeFor(tree, repo, false, false, 248).removed).toBe(true)
      expect(existsSync(guard.GIT_CONFIG_VALUE_0)).toBe(false)
      expect(() => removeSharedRefGuard(repo, 248)).not.toThrow()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('shared-ref guard litter cleanup reclaims terminal orphans and skips live runs', () => {
    const repo = cloneRepository('orch-guard-litter-')
    const terminal = addRun({ agent: 'codex', job: 'implement', status: 'ok' })
    const live = addRun({ agent: 'codex', job: 'implement', status: 'running' })
    try {
      const guardRoot = join(realpathSync(repo), '.git', 'orch-guards')
      mkdirSync(join(guardRoot, String(terminal)), { recursive: true })
      mkdirSync(join(guardRoot, String(live)), { recursive: true })
      writeFileSync(join(guardRoot, String(terminal), 'reference-transaction'), 'litter\n')
      writeFileSync(join(guardRoot, String(live), 'reference-transaction'), 'live\n')

      const tree = createWorktree(repo, 250)
      prepareSharedRefGuard(tree.path)

      expect(existsSync(join(guardRoot, String(terminal)))).toBe(false)
      expect(existsSync(join(guardRoot, String(live)))).toBe(true)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a common-dir guard refuses main for a worker on a flat branch', () => {
    const repo = cloneRepository('orch-guard-flat-branch-')
    const git = (cwd: string, args: string[], env: Record<string, string> = {}) =>
      Bun.spawnSync(['git', ...args], {
        cwd, env: hermeticGitEnv(env), stdout: 'pipe', stderr: 'pipe',
      })
    try {
      const tree = createWorktree(repo, 249)
      expect(git(tree.path, ['branch', '-m', 'flat-worker']).exitCode).toBe(0)
      const guard = prepareSharedRefGuard(tree.path, 'refs/heads/flat-worker')
      expect(guard.GIT_CONFIG_VALUE_0).toBe(join(realpathSync(repo), '.git', 'orch-guards', '249'))
      const forbidden = git(tree.path, ['update-ref', 'refs/heads/main', 'HEAD'], guard)
      expect(forbidden.exitCode).not.toBe(0)
      expect(forbidden.stderr.toString()).toContain(
        'refusing shared ref update refs/heads/main: this worker may update only refs/heads/flat-worker',
      )
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('shared-ref guard preparation is idempotent under its inherited hooks path', () => {
    const repo = cloneRepository('orch-guard-idempotent-')
    const sharedGuard = realpathSync(new URL('../hooks/reference-transaction', import.meta.url).pathname)
    const sharedBefore = readFileSync(sharedGuard)
    try {
      const tree = createWorktree(repo, 225)

      const first = prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)
      const installed = join(first.GIT_CONFIG_VALUE_0, 'reference-transaction')
      expect(readFileSync(installed)).toEqual(readFileSync(sharedGuard))

      const installedBefore = readFileSync(installed)
      writeFileSync(join(first.GIT_CONFIG_VALUE_0,
        '.reference-transaction-99999999-interrupted'), 'litter\n')
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
      process.env.GIT_CONFIG_VALUE_0 = first.GIT_CONFIG_VALUE_0
      let second: ReturnType<typeof prepareSharedRefGuard> | undefined
      try {
        second = prepareSharedRefGuard(tree.path, `refs/heads/${tree.branch}`)
      } finally {
        delete process.env.GIT_CONFIG_COUNT
        delete process.env.GIT_CONFIG_KEY_0
        delete process.env.GIT_CONFIG_VALUE_0
      }
      expect(second).toEqual(first)
      expect(readFileSync(sharedGuard)).toEqual(sharedBefore)
      expect(readFileSync(installed)).toEqual(installedBefore)
      expect(readdirSync(first.GIT_CONFIG_VALUE_0)).toEqual(['reference-transaction'])
      expect(readFileSync(installed)).toEqual(readFileSync(sharedGuard))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('shared-ref guard config reads ignore an inherited worker hooks path', () => {
    const repo = cloneRepository('orch-guard-hostile-config-')
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      const projectHooks = join(repo, 'project-hooks')
      const hostileHooks = join(repo, 'hostile-hooks')
      mkdirSync(projectHooks)
      mkdirSync(hostileHooks)
      const projectHook = join(projectHooks, 'reference-transaction')
      const hostileHook = join(hostileHooks, 'reference-transaction')
      writeFileSync(projectHook, '#!/bin/sh\necho project\n')
      writeFileSync(hostileHook, '#!/bin/sh\necho hostile\n')
      chmodSync(projectHook, 0o755)
      chmodSync(hostileHook, 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      const tree = createWorktree(repo, 229)

      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
      process.env.GIT_CONFIG_VALUE_0 = hostileHooks
      let guardEnv: ReturnType<typeof prepareSharedRefGuard> | undefined
      try {
        guardEnv = prepareSharedRefGuard(tree.path)
      } finally {
        delete process.env.GIT_CONFIG_COUNT
        delete process.env.GIT_CONFIG_KEY_0
        delete process.env.GIT_CONFIG_VALUE_0
      }
      const wrapper = readFileSync(join(guardEnv!.GIT_CONFIG_VALUE_0, 'reference-transaction'), 'utf8')
      expect(wrapper).toContain(Buffer.from(realpathSync(projectHook)).toString('base64'))
      expect(wrapper).not.toContain(Buffer.from(realpathSync(hostileHook)).toString('base64'))
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

describe('shared ref guard path decisions', () => {
test('shared-ref guard recognition is independent of the running checkout path', () => {
    const repo = cloneRepository('orch-guard-other-checkout-')
    const git = (cwd: string, args: string[]) => Bun.spawnSync(['git', ...args], {
      cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
    })
    try {
      const tree = createWorktree(repo, 230)
      const hookDir = join(realpathSync(repo), '.git', 'orch-guards', '230')
      const installed = join(hookDir, 'reference-transaction')
      const otherCheckoutGuard = join(repo, 'other-checkout', 'orchestrator', 'hooks',
        'reference-transaction')
      mkdirSync(join(repo, 'other-checkout', 'orchestrator', 'hooks'), { recursive: true })
      writeFileSync(otherCheckoutGuard, readFileSync(
        new URL('../hooks/reference-transaction', import.meta.url).pathname,
      ))
      chmodSync(otherCheckoutGuard, 0o755)
      mkdirSync(hookDir, { recursive: true })
      symlinkSync(otherCheckoutGuard, installed)

      const guardEnv = prepareSharedRefGuard(tree.path)
      expect(guardEnv.GIT_CONFIG_VALUE_0).toBe(hookDir)
      expect(realpathSync(installed)).toBe(realpathSync(otherCheckoutGuard))

      rmSync(installed)
      const projectHooks = join(repo, 'project-hooks')
      mkdirSync(projectHooks)
      const projectHook = join(projectHooks, 'reference-transaction')
      writeFileSync(projectHook, '#!/bin/sh\nexit 0\n')
      chmodSync(projectHook, 0o755)
      expect(git(repo, ['config', 'core.hooksPath', projectHooks]).exitCode).toBe(0)
      prepareSharedRefGuard(tree.path)
      const runningGuard = realpathSync(new URL('../hooks/reference-transaction', import.meta.url).pathname)
      const otherWrapper = readFileSync(installed, 'utf8')
        .replace(Buffer.from(runningGuard).toString('base64'),
          Buffer.from(realpathSync(otherCheckoutGuard)).toString('base64'))
        .replace(`'${runningGuard}' "$@"`, `'${realpathSync(otherCheckoutGuard)}' "$@"`)
      writeFileSync(installed, otherWrapper)
      chmodSync(installed, 0o755)

      expect(prepareSharedRefGuard(tree.path)).toEqual(guardEnv)
      expect(readFileSync(installed, 'utf8')).toBe(otherWrapper)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

})
