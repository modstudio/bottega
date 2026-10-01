import { afterEach, expect, mock, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { closeOutRun } from './close-out.ts'
import {
  archivedClonePath,
  cleanFixture,
  closeOutFixture,
  commit,
} from './reader-scratch-close-out.fixture.ts'

afterEach(() => mock.restore())

test('reader close-out archives a reader-only detached HEAD commit', () => {
  const fixture = closeOutFixture()
  try {
    writeFileSync(join(fixture.worktree, 'reader-only.txt'), 'committed in reader\n')
    commit(fixture.worktree, 'reader-only commit')
    const result = closeOutRun(fixture.id, { intent: 'terminal' })
    const archive = archivedClonePath(result.detail)
    expect(result.outcome).toBe('released')
    expect(readFileSync(join(archive, 'reader-only.txt'), 'utf8')).toBe('committed in reader\n')
    expect(existsSync(join(archive, '.git'))).toBe(true)
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})
