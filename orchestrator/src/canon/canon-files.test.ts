import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectCanonTreeAtRef, isCanonPath } from './canon-files.ts'

let root: string | null = null

test('workflow and skill agent content is outside the canon pack', () => {
  expect(
    [
      '.agents/workflows/fixture-workflow.md',
      '.agents/workflow-steps/verify.md',
      '.agents/skills/cleanup/SKILL.md',
    ].map(isCanonPath),
  ).toEqual([false, false, false])
})

function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: root!,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
  root = null
})

describe('committed canon tree', () => {
  test('reads the remote-tracking ref instead of a stale checkout', () => {
    root = mkdtempSync(join(tmpdir(), 'canon-ref-tree-'))
    git('init', '--initial-branch=main')
    git('config', 'user.email', 'fixture@example.test')
    git('config', 'user.name', 'Fixture')
    mkdirSync(join(root, '.agents/rules'), { recursive: true })
    writeFileSync(join(root, '.agents/rules/example.md'), 'stale\n')
    git('add', '.')
    git('commit', '-m', 'fixture stale')
    const stale = git('rev-parse', 'HEAD')
    writeFileSync(join(root, '.agents/rules/example.md'), 'landed\n')
    git('commit', '-am', 'fixture landed')
    const landed = git('rev-parse', 'HEAD')
    git('update-ref', 'refs/remotes/origin/main', landed)
    git('checkout', '--detach', stale)

    expect(collectCanonTreeAtRef(root, 'origin/main')).toEqual({
      ref: 'origin/main',
      commit: landed,
      tree: [{ path: '.agents/rules/example.md', text: 'landed\n' }],
    })
  })
})
