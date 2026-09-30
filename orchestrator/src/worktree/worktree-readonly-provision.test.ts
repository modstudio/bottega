import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { git } from '../git/git-environment.ts'
import { createReadOnlyWorktree } from './worktree-readonly.ts'

test('a required read-only provision identifies the project register declaration', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'orch-readonly-required-'))
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
    const base = git(['rev-parse', 'HEAD'], repoRoot)
    const path = join(repoRoot, '.claude', 'worktrees', `orch-${runId}`)

    expect(() =>
      createReadOnlyWorktree(repoRoot, runId, base, undefined, [
        { path: 'node_modules', method: 'link', required: true },
      ]),
    ).toThrow('from the project register row')
    expect(existsSync(path)).toBeFalse()
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})
