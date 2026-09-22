import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { repositoryWorkerSharedGitRoots } from './run-writable-roots.ts'

test('readers get common objects without refs while writer roots stay unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'orch-writable-roots-'))
  try {
    const common = join(root, 'repo.git')
    const gitDir = join(common, 'worktrees', 'DEV-832')
    const worktree = join(root, 'worktree')
    mkdirSync(join(common, 'objects'), { recursive: true })
    mkdirSync(join(common, 'refs', 'heads'), { recursive: true })
    mkdirSync(join(common, 'logs', 'refs', 'heads'), { recursive: true })
    mkdirSync(gitDir, { recursive: true })
    mkdirSync(worktree)
    writeFileSync(join(gitDir, 'commondir'), '../..\n')
    writeFileSync(join(worktree, '.git'), `gitdir: ${gitDir}\n`)

    const canonicalCommon = realpathSync(common)
    const objects = join(canonicalCommon, 'objects')
    const refs = join(canonicalCommon, 'refs', 'heads')
    const reflogs = join(canonicalCommon, 'logs', 'refs', 'heads')
    const readerRoots = repositoryWorkerSharedGitRoots(worktree, 'DEV-832', false)
    expect(readerRoots).toEqual([objects])
    expect(readerRoots).not.toContain(refs)
    expect(repositoryWorkerSharedGitRoots(worktree, 'DEV-832', true)).toEqual([
      objects,
      refs,
      reflogs,
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
