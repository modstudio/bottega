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

test('reader close-out releases a clean clone without nested repositories', () => {
  const fixture = closeOutFixture()
  try {
    const result = closeOutRun(fixture.id, { intent: 'terminal' })

    expect(result).toMatchObject({ outcome: 'released' })
    expect(existsSync(fixture.worktree)).toBe(false)
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})

test('reader close-out archives a dirty initialized submodule', () => {
  const fixture = closeOutFixture({ submodule: true })
  try {
    writeFileSync(join(fixture.worktree, 'nested', 'nested.txt'), 'dirty nested\n')
    writeFileSync(join(fixture.worktree, 'nested', 'untracked.txt'), 'untracked nested\n')
    const result = closeOutRun(fixture.id, { intent: 'terminal' })
    const archive = archivedClonePath(result.detail)
    expect(result.outcome).toBe('released')
    expect(readFileSync(join(archive, 'nested', 'nested.txt'), 'utf8')).toBe('dirty nested\n')
    expect(readFileSync(join(archive, 'nested', 'untracked.txt'), 'utf8')).toBe(
      'untracked nested\n',
    )
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})

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

test('reader close-out archives deinitialised submodule Git storage', () => {
  const fixture = closeOutFixture({ submodule: true })
  try {
    git(['submodule', 'deinit', '-f', 'nested'], fixture.worktree)
    const result = closeOutRun(fixture.id, { intent: 'terminal' })
    const archive = archivedClonePath(result.detail)
    expect(result.outcome).toBe('released')
    expect(existsSync(join(archive, '.git', 'modules', 'nested', 'HEAD'))).toBe(true)
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})
