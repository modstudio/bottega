import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git/git-environment.ts'
import { createReadOnlyWorktree } from './worktree-readonly.ts'

test('built-in read-only creation removes the clone when checkout fails', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'orch-readonly-worktree-failure-'))
  const runId = 829
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
    const path = join(repoRoot, '.claude', 'worktrees', `orch-${runId}`)

    expect(() =>
      createReadOnlyWorktree(repoRoot, runId, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
    ).toThrow()
    expect(existsSync(path)).toBeFalse()
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})
