import { afterEach, expect, mock, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '../git/git-environment.ts'
import { closeOutRun } from './close-out.ts'
import {
  archivedClonePath,
  cleanFixture,
  closeOutFixture,
} from './reader-scratch-close-out.fixture.ts'

afterEach(() => mock.restore())

test('reader close-out archives dirty submodule scratch hidden by ignore=all', () => {
  const fixture = closeOutFixture({ submodule: true })
  const nested = join(fixture.worktree, 'nested')
  try {
    git(['config', 'submodule.nested.ignore', 'all'], fixture.worktree)
    writeFileSync(join(nested, 'nested.txt'), 'modified\n')
    writeFileSync(join(nested, 'untracked.txt'), 'scratch\n')
    expect(git(['status', '--porcelain'], fixture.worktree)).toBe('')

    const result = closeOutRun(fixture.id, { intent: 'terminal' })

    expect(result).toMatchObject({ outcome: 'released' })
    const archive = archivedClonePath(result.detail)
    expect(existsSync(fixture.worktree)).toBe(false)
    expect(readFileSync(join(archive, 'nested', 'nested.txt'), 'utf8')).toBe('modified\n')
    expect(readFileSync(join(archive, 'nested', 'untracked.txt'), 'utf8')).toBe('scratch\n')
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})
