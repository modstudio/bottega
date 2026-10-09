import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git/git-environment.ts'
import { createReadOnlyWorktree } from './worktree-readonly.ts'

test('built-in read-only trees are detached shared clones with private refs', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'orch-readonly-worktree-'))
  const runId = 828

  try {
    git(['init', '--initial-branch=main'], repoRoot)
    git(
      [
        '-c',
        'user.name=Orch Test',
        '-c',
        'user.email=orch@example.invalid',
        'commit',
        '--allow-empty',
        '-m',
        'initial',
      ],
      repoRoot,
    )
    const base = git(['rev-parse', 'HEAD'], repoRoot)
    const remoteRefs = join(repoRoot, '.git', 'refs', 'remotes', 'origin')
    mkdirSync(remoteRefs, { recursive: true })
    writeFileSync(join(remoteRefs, 'develop'), `${base}\n`)

    const worktree = createReadOnlyWorktree(repoRoot, runId, base)
    expect(statSync(join(worktree.path, '.git')).isDirectory()).toBe(true)
    expect(git(['rev-parse', 'HEAD', 'refs/remotes/origin/develop'], worktree.path)).toBe(
      `${base}\n${base}`,
    )
    expect(readFileSync(join(worktree.path, '.git', 'HEAD'), 'utf8').trim()).toBe(base)
    expect(
      readFileSync(join(worktree.path, '.git', 'objects', 'info', 'alternates'), 'utf8').trim(),
    ).toEndWith('/.git/objects')
    expect(readFileSync(join(worktree.path, '.git', 'config'), 'utf8')).not.toContain(
      '[remote "origin"]',
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})
