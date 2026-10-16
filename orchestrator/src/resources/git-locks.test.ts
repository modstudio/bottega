import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { worktreeIndexLockPaths } from './git-locks.ts'

test('finds linked-worktree index locks directly under the common Git directory', () => {
  const commonDir = mkdtempSync(join(tmpdir(), 'git-locks-common-'))
  const adminDir = join(commonDir, 'worktrees', 'missing')
  const indexLock = join(adminDir, 'index.lock')
  try {
    mkdirSync(adminDir, { recursive: true })
    writeFileSync(indexLock, '')

    expect(worktreeIndexLockPaths(commonDir)).toEqual([indexLock])
  } finally {
    rmSync(commonDir, { recursive: true, force: true })
  }
})
