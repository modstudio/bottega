import { expect, test, describe } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hermeticGitEnv, repoRootOf, worktreeDescribeFixture } from "../test/fixture.ts"
import { contentTree } from "./git-environment.ts"
test('--cwd carry measures the same input tree as launching inside that worktree', () => {
  const repo = mkdtempSync(join(tmpdir(), 'orch-content-tree-'))
  try {
    const git = (...args: string[]) => Bun.spawnSync(['git', ...args], { cwd: repo, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    git('init', '-b', 'main'); git('config', 'user.email', 'orch-test@example.invalid'); git('config', 'user.name', 'Orch Test')
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
