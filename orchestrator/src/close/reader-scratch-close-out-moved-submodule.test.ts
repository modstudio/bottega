import { afterEach, expect, mock, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '../git/git-environment.ts'
import { closeOutRun } from './close-out.ts'
import {
  archivedClonePath,
  cleanFixture,
  closeOutFixture,
  commit,
} from './reader-scratch-close-out.fixture.ts'

afterEach(() => mock.restore())

test('reader close-out archives a clean submodule moved to a reader-only commit', () => {
  const fixture = closeOutFixture({ submodule: true })
  const nested = join(fixture.worktree, 'nested')
  try {
    writeFileSync(join(nested, 'reader-only.txt'), 'committed only in reader clone\n')
    commit(nested, 'reader-only nested commit')
    expect(git(['status', '--porcelain'], nested)).toBe('')

    const result = closeOutRun(fixture.id, { intent: 'terminal' })

    expect(result).toMatchObject({ outcome: 'released' })
    const archive = archivedClonePath(result.detail)
    expect(existsSync(fixture.worktree)).toBe(false)
    expect(readFileSync(join(archive, 'nested', 'reader-only.txt'), 'utf8')).toBe(
      'committed only in reader clone\n',
    )
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})
