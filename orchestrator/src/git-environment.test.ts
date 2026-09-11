import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hermeticGitEnv } from '../test/fixture.ts'
import { contentTree } from './git-environment.ts'

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
