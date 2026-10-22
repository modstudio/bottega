import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareSyntheticGateIndex } from './gate-index.ts'

function git(root: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  return result.stdout.toString().trim()
}

test('the synthetic index stages the whole current tree without touching the real index or HEAD', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-gate-index-'))
  const indexDirectory = mkdtempSync(join(tmpdir(), 'orch-gate-index-state-'))
  const indexPath = join(indexDirectory, 'synthetic.index')
  let removeIndex: (() => void) | undefined
  try {
    git(root, ['init', '-q'])
    git(root, ['config', 'user.email', 'fixture@example.com'])
    git(root, ['config', 'user.name', 'Fixture'])
    writeFileSync(join(root, 'tracked.txt'), 'base\n')
    git(root, ['add', 'tracked.txt'])
    git(root, ['commit', '-qm', 'base'])
    const base = git(root, ['rev-parse', 'HEAD'])
    writeFileSync(join(root, 'tracked.txt'), 'changed\n')
    writeFileSync(join(root, 'untracked.txt'), 'new\n')
    const realIndexBefore = git(root, ['write-tree'])

    const prepared = prepareSyntheticGateIndex({ worktree: root, baseCommit: base, indexPath })
    removeIndex = prepared.remove

    expect(
      git(root, ['diff', '--cached', '--name-only', base], prepared.environment).split('\n'),
    ).toEqual(['tracked.txt', 'untracked.txt'])
    expect(git(root, ['write-tree'])).toBe(realIndexBefore)
    expect(git(root, ['rev-parse', 'HEAD'])).toBe(base)
  } finally {
    removeIndex?.()
    rmSync(root, { recursive: true, force: true })
    rmSync(indexDirectory, { recursive: true, force: true })
  }
})
