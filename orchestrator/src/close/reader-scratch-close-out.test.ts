import { afterEach, expect, mock, test } from 'bun:test'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { addRun } from '../../test/fixtures/store.ts'
import { db, nowIso } from '../database/db.ts'
import { git } from '../git/git-environment.ts'
import { recordCreatedWorktreeClaims, settleClaims } from '../resources/resource-claims.ts'
import { runArtifactsDir } from '../run/run-artifacts.ts'
import { closeOutRun } from './close-out.ts'
import {
  archivedClonePath,
  cleanFixture,
  closeOutFixture,
} from './reader-scratch-close-out.fixture.ts'

afterEach(() => mock.restore())

test('last shared reader archives committed and uncommitted changes after the creator terminates', () => {
  const fixture = closeOutFixture()
  const attacher = addRun({ agent: 'claude', job: 'review-lens', status: 'ok' })
  try {
    const base = git(['rev-parse', 'HEAD'], fixture.worktree)
    recordCreatedWorktreeClaims(db(), {
      rootRunId: fixture.id,
      runId: fixture.id,
      projectId: null,
      owned: true,
      path: fixture.worktree,
      head: base,
      sharedReader: true,
      mintedBranch: null,
      label: fixture.id,
      claimedAt: nowIso(),
    })
    db()
      .query(
        `UPDATE run SET repo=?,cwd=?,worktree=?,branch=NULL,minted_branch=NULL,base_commit=?,
         worktree_source='clone',head_commit=? WHERE record_id=?`,
      )
      .run('shared-reader-attacher', fixture.worktree, fixture.worktree, base, base, attacher)
    recordCreatedWorktreeClaims(db(), {
      rootRunId: attacher,
      runId: attacher,
      projectId: null,
      owned: true,
      path: fixture.worktree,
      head: base,
      sharedReader: true,
      mintedBranch: null,
      label: attacher,
      claimedAt: nowIso(),
    })
    settleClaims(db(), {
      rootRunId: fixture.id,
      kind: 'worktree',
      state: 'released',
      settledAt: nowIso(),
      detail: 'creator conversation terminated',
    })
    writeFileSync(join(fixture.worktree, 'tracked.txt'), 'escaped\n')
    git(['add', 'tracked.txt'], fixture.worktree)
    git(
      [
        '-c',
        'user.name=Orch Test',
        '-c',
        'user.email=orch@example.invalid',
        'commit',
        '-m',
        'escape',
      ],
      fixture.worktree,
    )
    writeFileSync(join(fixture.worktree, 'untracked.txt'), 'escaped untracked\n')

    const result = closeOutRun(attacher, { intent: 'terminal' })
    const archive = archivedClonePath(result.detail)
    const pointer = JSON.parse(
      readFileSync(join(runArtifactsDir(attacher), 'reader-clone-archive.json'), 'utf8'),
    )
    expect(result.outcome).toBe('released')
    expect(existsSync(join(archive, 'head.bundle'))).toBeTrue()
    git(['bundle', 'verify', join(archive, 'head.bundle')], fixture.repo)
    expect(readFileSync(join(archive, 'untracked', 'untracked.txt'), 'utf8')).toBe(
      'escaped untracked\n',
    )
    expect(existsSync(join(archive, 'tracked.txt'))).toBeFalse()
    expect(pointer).toMatchObject({
      sharedPath: fixture.worktree,
      sharerRunIds: [fixture.id, attacher],
      headBundle: join(archive, 'head.bundle'),
    })
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})

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

test('reader close-out archives a clean clone with a repository in a tracked directory', () => {
  const fixture = closeOutFixture({ trackedDirectory: true })
  try {
    const nested = join(fixture.worktree, 'tracked-directory')
    git(['init', '--initial-branch=main'], nested)

    const result = closeOutRun(fixture.id, { intent: 'terminal' })
    const archive = archivedClonePath(result.detail)

    expect(result.outcome).toBe('released')
    expect(existsSync(fixture.worktree)).toBe(false)
    expect(existsSync(join(archive, 'tracked-directory', '.git'))).toBe(true)
  } finally {
    cleanFixture(fixture.repo, fixture.nestedSource)
  }
})

test('reader close-out archives an untracked non-ignored nested repository', () => {
  const fixture = closeOutFixture()
  try {
    const nested = join(fixture.worktree, 'untracked-repository')
    mkdirSync(nested, { recursive: true })
    git(['init', '--initial-branch=main'], nested)

    const result = closeOutRun(fixture.id, { intent: 'terminal' })
    const archive = archivedClonePath(result.detail)

    expect(result.outcome).toBe('released')
    expect(existsSync(fixture.worktree)).toBe(false)
    expect(existsSync(join(archive, 'untracked-repository', '.git'))).toBe(true)
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
