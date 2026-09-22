import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git, gitOk } from '../git/git-environment.ts'
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

    const worktree = createReadOnlyWorktree(repoRoot, runId, base)
    expect(statSync(join(worktree.path, '.git')).isDirectory()).toBe(true)
    expect(git(['rev-parse', 'HEAD'], worktree.path)).toBe(base)
    expect(gitOk(['symbolic-ref', '--quiet', 'HEAD'], worktree.path)).toBeNull()
    expect(
      readFileSync(join(worktree.path, '.git', 'objects', 'info', 'alternates'), 'utf8').trim(),
    ).toEndWith('/.git/objects')
    expect(git(['remote'], worktree.path)).toBe('')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})
