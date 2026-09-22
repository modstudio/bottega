import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git/git-environment.ts'
import { createReadOnlyWorktree } from './worktree-readonly.ts'
import { removeWorktree } from './worktree-remove.ts'

test('built-in read-only worktrees use relative git pointers', () => {
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
    const pointer = readFileSync(join(worktree.path, '.git'), 'utf8').trim()
    expect(pointer).toStartWith('gitdir: ')
    expect(pointer.slice('gitdir: '.length)).not.toStartWith('/')

    const adminPointer = readFileSync(
      join(repoRoot, '.git', 'worktrees', `orch-${runId}`, 'gitdir'),
      'utf8',
    ).trim()
    expect(adminPointer).not.toStartWith('/')

    expect(removeWorktree(worktree)).toEqual({ removed: true, detail: worktree.path })
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})
