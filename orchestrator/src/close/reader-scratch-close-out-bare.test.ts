import { afterEach, expect, mock, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '../git/git-environment.ts'
import { closeOutRun } from './close-out.ts'
import {
  archivedClonePath,
  cleanFixture,
  closeOutFixture,
} from './reader-scratch-close-out.fixture.ts'

afterEach(() => mock.restore())

test('reader close-out archives a nested bare repository', () => {
  const fixture = closeOutFixture()
  try {
    const bare = join(fixture.worktree, 'probe.git')
    git(['init', '--bare', bare], fixture.worktree)
    const result = closeOutRun(fixture.id, { intent: 'terminal' })
    const archive = archivedClonePath(result.detail)
    expect(result.outcome).toBe('released')
    expect(existsSync(join(archive, 'probe.git', 'HEAD'))).toBe(true)
    expect(existsSync(join(archive, 'probe.git', 'objects'))).toBe(true)
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})
