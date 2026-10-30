import { afterEach, expect, mock, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git } from '../git/git-environment.ts'
import { runArtifactsDir } from '../run/run-artifacts.ts'
import { closeOutRun } from './close-out.ts'
import {
  archivedClonePath,
  cleanFixture,
  closeOutFixture,
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

test('reader close-out releases a clean clone at its carry base instead of the trunk base', () => {
  const fixture = closeOutFixture({ carryBase: true })
  try {
    const result = closeOutRun(fixture.id, { intent: 'terminal' })

    expect(result).toMatchObject({ outcome: 'released' })
    expect(existsSync(fixture.worktree)).toBe(false)
    expect(existsSync(join(runArtifactsDir(fixture.id), 'reader-clone-archive.json'))).toBe(false)
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
    expect(
      JSON.parse(
        readFileSync(join(runArtifactsDir(fixture.id), 'reader-clone-archive.json'), 'utf8'),
      ),
    ).toMatchObject({
      clean: false,
      atBase: true,
      noUniqueCommits: true,
      noNestedStorage: false,
    })
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})

test('reader close-out removes ignored paths from an archived dirty clone', () => {
  const fixture = closeOutFixture()
  try {
    appendFileSync(
      join(fixture.worktree, '.git', 'info', 'exclude'),
      'node_modules/\nignored-storage/\n',
    )
    mkdirSync(join(fixture.worktree, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(fixture.worktree, 'node_modules', 'pkg', 'index.js'), 'ignored\n')
    mkdirSync(join(fixture.worktree, 'ignored-storage', '.git'), { recursive: true })
    writeFileSync(join(fixture.worktree, 'ignored-storage', '.git', 'HEAD'), 'ignored\n')
    writeFileSync(join(fixture.worktree, 'tracked.txt'), 'dirty\n')

    const result = closeOutRun(fixture.id, { intent: 'terminal' })
    const archive = archivedClonePath(result.detail)
    const pointer = JSON.parse(
      readFileSync(join(runArtifactsDir(fixture.id), 'reader-clone-archive.json'), 'utf8'),
    )

    expect(result.outcome).toBe('released')
    expect(
      git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory'], archive),
    ).toBe('')
    expect(pointer.ignoredRemoved).toBe(true)
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})

test('reader close-out releases a clean clone with nested Git storage only in an ignored path', () => {
  const fixture = closeOutFixture()
  try {
    appendFileSync(join(fixture.worktree, '.git', 'info', 'exclude'), 'ignored-storage/\n')
    mkdirSync(join(fixture.worktree, 'ignored-storage', '.git'), { recursive: true })
    writeFileSync(join(fixture.worktree, 'ignored-storage', '.git', 'HEAD'), 'ignored\n')

    const result = closeOutRun(fixture.id, { intent: 'terminal' })

    expect(result.outcome).toBe('released')
    expect(existsSync(fixture.worktree)).toBe(false)
    expect(existsSync(join(runArtifactsDir(fixture.id), 'reader-clone-archive.json'))).toBe(false)
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})
