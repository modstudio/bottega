import { expect, test, describe } from "bun:test"
import { mkdirSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'
import { worktreeDescribeFixture } from '../test/fixtures/worktree.ts'
import { repoRootOf } from './git-environment.ts'
import { contentTree, targetGitEnvironment } from "./git-environment.ts"
test('--cwd carry measures the same input tree as launching inside that worktree', () => {
  const repo = cloneRepository('orch-content-tree-')
  try {
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    writeFileSync(join(repo, 'tracked.txt'), 'fixture\n'); git('add', '.'); git('commit', '-m', 'fixture')
    const checkout = `${repo}-carried-tree`
    git('worktree', 'add', '--detach', checkout, 'HEAD')
    expect(contentTree(repo)).toBe(contentTree(checkout))
    rmSync(checkout, { recursive: true, force: true })
  } finally { rmSync(repo, { recursive: true, force: true }) }
})

describe('repository root decisions', () => {
const { git, scratchRepo } = worktreeDescribeFixture()
test('from inside a worktree, repoRootOf is the main checkout, not this tree', () => {
    const { repo, tree } = scratchRepo()
    const here = process.cwd()
    try {
      process.chdir(tree)
      const got = repoRootOf(process.cwd())
      expect(got).not.toBeNull()
      expect(realpathSync(got!)).toBe(realpathSync(repo))
      expect(realpathSync(got!)).not.toBe(realpathSync(tree))
      // And the naive --show-toplevel answer, which is what shipped, is the
      // worktree itself. If this ever stops being true the bug cannot recur
      // in the same shape and the test should be rewritten, not weakened.
      const toplevel = git(process.cwd(), 'rev-parse', '--show-toplevel')
      expect(realpathSync(toplevel)).toBe(realpathSync(tree))
    } finally {
      process.chdir(here)
      rmSync(repo, { recursive: true, force: true })
    }
  })

})

test('a guarded linked target receives its own object routing after inherited routing is scrubbed', () => {
    const repo = cloneRepository('orch-target-git-env-')
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
