import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnFixtureGitSync } from '../../test/fixtures/spawn.ts'
import { resolveDispatchBase } from '../dispatch/dispatch-commands.ts'
import { isWorktreeRelativeRef, resolveBase } from './git-environment.ts'

describe('git environment', () => {
  test('classifies only HEAD and @ revision expressions as worktree-relative', () => {
    for (const ref of ['HEAD', 'HEAD~1', 'HEAD^', '@', '@~2', 'HEAD@{1}']) {
      expect(isWorktreeRelativeRef(ref)).toBeTrue()
    }
    for (const ref of [
      'HEADING',
      'feature/HEAD',
      '0123456789abcdef0123456789abcdef01234567',
      'origin/main',
    ]) {
      expect(isWorktreeRelativeRef(ref)).toBeFalse()
    }
  })

  test('resolves HEAD in a linked worktree and branch names in the main checkout', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'resolve-base-worktree-'))
    const main = join(fixture, 'main')
    const tree = join(fixture, 'tree')
    const git = (cwd: string, ...args: string[]) => {
      const result = spawnFixtureGitSync(args, { cwd })
      if (result.exitCode !== 0) throw new Error(result.stderr.toString())
      return result.stdout.toString().trim()
    }
    try {
      git(fixture, 'init', '--quiet', '-b', 'main', main)
      git(main, 'config', 'user.name', 'Fixture')
      git(main, 'config', 'user.email', 'fixture@example.com')
      writeFileSync(join(main, 'file.txt'), 'base\n')
      git(main, 'add', 'file.txt')
      git(main, 'commit', '--quiet', '-m', 'base')
      const mainHead = git(main, 'rev-parse', 'HEAD')
      git(main, 'worktree', 'add', '--quiet', '-b', 'change', tree)
      writeFileSync(join(tree, 'file.txt'), 'changed\n')
      git(tree, 'commit', '--quiet', '-am', 'change')
      const treeHead = git(tree, 'rev-parse', 'HEAD')

      expect(resolveBase(tree, 'HEAD')).toBe(treeHead)
      expect(resolveBase(tree, 'main')).toBe(mainHead)
      expect(resolveDispatchBase(tree, 'HEAD', resolveBase, isWorktreeRelativeRef)).toBe(treeHead)
      expect(resolveDispatchBase(tree, 'main', resolveBase, isWorktreeRelativeRef)).toBe('main')
      expect(resolveDispatchBase(main, 'HEAD', resolveBase, isWorktreeRelativeRef)).toBe(mainHead)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
