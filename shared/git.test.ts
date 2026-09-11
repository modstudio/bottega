import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { hermeticGitEnv, mainCheckoutOf, scrubbedGitEnv, targetGitEnvironment, worktreeDescribeFixture } from "../orchestrator/test/fixture.ts"
describe('shared git environment decisions', () => {
const { fromRoot, git, scratchRepo } = worktreeDescribeFixture()
test('the shared scrub removes repository-location variables git lists and orch routing, not global-behaviour GIT_*', () => {
    const contaminated: NodeJS.ProcessEnv = {
      UNRELATED: 'preserved',
      GIT_DIR: '/worker/git-dir',
      GIT_WORK_TREE: '/worker/tree',
      GIT_OBJECT_DIRECTORY: '/worker/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/worker/alternates',
      GIT_INDEX_FILE: '/worker/index',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/worker/hooks',
      GIT_CONFIG_KEY_1: 'safe.directory',
      GIT_CONFIG_VALUE_1: '*',
      GIT_CONFIG_GLOBAL: '/worker/global-config',
      GIT_CONFIG_SYSTEM: '/worker/system-config',
      GIT_CONFIG_NOSYSTEM: '1',
      ORCH_GUARDED_GIT_COMMON_DIR: '/worker/common',
      ORCH_ALLOWED_GIT_REF: 'refs/heads/worker',
    }
    const scrubbed = scrubbedGitEnv(contaminated)
    expect(scrubbed.UNRELATED).toBe('preserved')
    for (const variable of [
      'GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT',
      'ORCH_GUARDED_GIT_COMMON_DIR', 'ORCH_ALLOWED_GIT_REF',
    ]) {
      expect(scrubbed[variable]).toBeUndefined()
    }
    expect(scrubbed.GIT_CONFIG_GLOBAL).toBe('/worker/global-config')
    expect(scrubbed.GIT_CONFIG_SYSTEM).toBe('/worker/system-config')
    expect(scrubbed.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(scrubbed.GIT_CONFIG_KEY_0).toBe('core.hooksPath')
    expect(scrubbed.GIT_CONFIG_VALUE_0).toBe('/worker/hooks')
  })

test('a guarded linked target receives its own object routing after inherited routing is scrubbed', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-target-git-env-'))
    const linked = join(repo, 'linked')
    const previous = Object.fromEntries([
      'GIT_DIR', 'GIT_WORK_TREE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0',
      'ORCH_GUARDED_GIT_COMMON_DIR', 'ORCH_ALLOWED_GIT_REF',
    ].map((key) => [key, process.env[key]]))
    const fixtureGit = (...args: string[]) => {
      const p = Bun.spawnSync(['git', ...args], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (p.exitCode !== 0) throw new Error(p.stderr.toString())
    }
    try {
      fixtureGit('init', '-b', 'main')
      fixtureGit('config', 'user.email', 'orch-test@example.invalid')
      fixtureGit('config', 'user.name', 'Orch Test')
      writeFileSync(join(repo, 'tracked'), 'fixture\n')
      fixtureGit('add', 'tracked')
      fixtureGit('commit', '-m', 'fixture')
      fixtureGit('worktree', 'add', '-b', 'guarded-target', linked)
      const pointer = readFileSync(join(linked, '.git'), 'utf8').trim().slice('gitdir: '.length)
      const linkedGitDir = realpathSync(resolve(linked, pointer))
      mkdirSync(join(linkedGitDir, 'objects'))
      Object.assign(process.env, {
        GIT_DIR: '/worker/git-dir', GIT_WORK_TREE: '/worker/tree',
        GIT_OBJECT_DIRECTORY: '/worker/objects', GIT_ALTERNATE_OBJECT_DIRECTORIES: '/worker/alternates',
        GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: '/worker/hooks',
        ORCH_GUARDED_GIT_COMMON_DIR: '/worker/common', ORCH_ALLOWED_GIT_REF: 'refs/heads/worker',
      })
      const target = targetGitEnvironment(linked)
      expect(target.GIT_OBJECT_DIRECTORY).toBe(join(linkedGitDir, 'objects'))
      expect(target.GIT_ALTERNATE_OBJECT_DIRECTORIES).toBe(realpathSync(join(repo, '.git', 'objects')))
      expect(target.GIT_DIR).toBeUndefined()
      expect(target.GIT_CONFIG_COUNT).toBeUndefined()
      expect(target.ORCH_GUARDED_GIT_COMMON_DIR).toBeUndefined()
      expect(target.ORCH_ALLOWED_GIT_REF).toBeUndefined()
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(repo, { recursive: true, force: true })
    }
  })

test('main checkout resolution does not merge inherited object routing into a supplied environment', () => {
    const repo = mkdtempSync(join(tmpdir(), 'orch-main-checkout-env-'))
    const previous = process.env.GIT_OBJECT_DIRECTORY
    try {
      const initialized = Bun.spawnSync(['git', 'init', '-b', 'main'], {
        cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
      })
      if (initialized.exitCode !== 0) throw new Error(initialized.stderr.toString())
      process.env.GIT_OBJECT_DIRECTORY = '/nonexistent/worker/objects'
      expect(mainCheckoutOf(repo, hermeticGitEnv())).toBe(realpathSync(repo))
    } finally {
      if (previous === undefined) delete process.env.GIT_OBJECT_DIRECTORY
      else process.env.GIT_OBJECT_DIRECTORY = previous
      rmSync(repo, { recursive: true, force: true })
    }
  })

})
