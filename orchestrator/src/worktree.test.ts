import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hermeticGitEnv } from '../test/fixture.ts'
import { createWorktree, resolveBase } from './worktree.ts'

function repo() {
  const path = mkdtempSync(join(tmpdir(), 'orch-base-test-'))
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: path, env: hermeticGitEnv(), stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git('init', '-b', 'main'); git('config', 'user.email', 'orch-test@example.invalid'); git('config', 'user.name', 'Orch Test')
  writeFileSync(join(path, 'base.txt'), 'base\n'); git('add', '.'); git('commit', '-m', 'base')
  return { path, git }
}

test("an implicit writing base is the caller's HEAD", () => {
  const fixture = repo()
  try {
    fixture.git('checkout', '-b', 'topic'); writeFileSync(join(fixture.path, 'topic.txt'), 'topic\n')
    fixture.git('add', '.'); fixture.git('commit', '-m', 'topic')
    expect(resolveBase(fixture.path, 'HEAD')).toBe(fixture.git('rev-parse', 'HEAD'))
  } finally { rmSync(fixture.path, { recursive: true, force: true }) }
})

test('fix --base creates its worktree at the requested commit', () => {
  const fixture = repo()
  try {
    const base = fixture.git('rev-parse', 'HEAD')
    writeFileSync(join(fixture.path, 'later.txt'), 'later\n'); fixture.git('add', '.'); fixture.git('commit', '-m', 'later')
    const tree = createWorktree(fixture.path, 987654, base)
    expect(tree.base).toBe(base)
    expect(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: tree.path, stdout: 'pipe' }).stdout.toString().trim()).toBe(base)
    if (existsSync(tree.path)) rmSync(tree.path, { recursive: true, force: true })
  } finally { rmSync(fixture.path, { recursive: true, force: true }) }
})

