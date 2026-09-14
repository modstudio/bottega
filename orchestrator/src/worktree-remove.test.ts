import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cloneRepository, hermeticGitEnv } from '../test/fixtures/git.ts'
import { removeWorktree, type Worktree } from './worktree.ts'

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

function fixture(): {
  root: string
  a: Worktree
  bPath: string
  aAdmin: string
  bAdmin: string
} {
  const root = mkdtempSync(join(tmpdir(), 'orch-worktree-remove-'))
  const repo = cloneRepository('orch-worktree-remove-repo-')
  const aPath = join(root, 'wt-a')
  const bPath = join(root, 'wt-b')
  git(repo, 'commit', '--allow-empty', '-m', 'fixture')
  git(repo, 'worktree', 'add', '-b', 'branch-a', aPath, 'HEAD')
  git(repo, 'worktree', 'add', '-b', 'branch-b', bPath, 'HEAD')
  return {
    root,
    a: { path: aPath, branch: 'branch-a', base: 'HEAD', repoRoot: repo },
    bPath,
    aAdmin: git(aPath, 'rev-parse', '--absolute-git-dir'),
    bAdmin: git(bPath, 'rev-parse', '--absolute-git-dir'),
  }
}

function expectSiblingSurvives(bPath: string, bAdmin: string): void {
  expect(existsSync(bAdmin)).toBe(true)
  expect(() => git(bPath, 'status', '--short')).not.toThrow()
}

describe('removeWorktree', () => {
  test("removes only the requested worktree's administrative record", () => {
    const { root, a, bPath, aAdmin, bAdmin } = fixture()
    const bAside = join(root, 'wt-b-aside')
    try {
      renameSync(bPath, bAside)
      const result = removeWorktree(a, true)
      renameSync(bAside, bPath)

      expect(result).toEqual({ removed: true, detail: a.path })
      expect(existsSync(aAdmin)).toBe(false)
      expectSiblingSurvives(bPath, bAdmin)
    } finally {
      if (existsSync(bAside) && !existsSync(bPath)) renameSync(bAside, bPath)
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('removes its stale record when its directory is already gone', () => {
    const { root, a, bPath, aAdmin, bAdmin } = fixture()
    const bAside = join(root, 'wt-b-aside')
    try {
      rmSync(a.path, { recursive: true, force: true })
      renameSync(bPath, bAside)
      const result = removeWorktree(a, true)
      renameSync(bAside, bPath)

      expect(result).toEqual({ removed: true, detail: `${a.path} was already gone` })
      expect(existsSync(aAdmin)).toBe(false)
      expectSiblingSurvives(bPath, bAdmin)
    } finally {
      if (existsSync(bAside) && !existsSync(bPath)) renameSync(bAside, bPath)
      rmSync(root, { recursive: true, force: true })
    }
  })
})
