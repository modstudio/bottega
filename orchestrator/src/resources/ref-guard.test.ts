import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { assertSharedRefGuardOutsideWritableRoots, workerSharedGitRoots } from './ref-guard.ts'

test('dispatch accepts packed-only slash-branch roots when the loose namespace is absent', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'ref-guard-packed-'))
  try {
    const commonDir = join(scratch, 'repo.git')
    const gitDir = join(commonDir, 'worktrees', 'run')
    const tree = join(scratch, 'tree')
    const hookDir = join(scratch, 'hooks')
    const guard = join(hookDir, 'reference-transaction')
    mkdirSync(join(commonDir, 'objects'), { recursive: true })
    mkdirSync(join(commonDir, 'refs', 'heads'), { recursive: true })
    mkdirSync(join(commonDir, 'logs', 'refs', 'heads'), { recursive: true })
    mkdirSync(gitDir, { recursive: true })
    mkdirSync(tree)
    mkdirSync(hookDir)
    writeFileSync(
      join(commonDir, 'packed-refs'),
      '# pack\n0123456789abcdef0123456789abcdef01234567 refs/heads/orch/11748\n',
    )
    writeFileSync(join(gitDir, 'commondir'), '../..\n')
    writeFileSync(join(tree, '.git'), `gitdir: ${gitDir}\n`)
    writeFileSync(guard, '#!/bin/sh\n')

    const roots = workerSharedGitRoots(tree, 'orch/11748')
    const namespace = roots.find((root) => root.endsWith(`${sep}refs${sep}heads${sep}orch`))
    expect(namespace).toBeDefined()
    expect(existsSync(namespace!)).toBe(false)

    expect(() => assertSharedRefGuardOutsideWritableRoots(hookDir, guard, roots)).not.toThrow()
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
