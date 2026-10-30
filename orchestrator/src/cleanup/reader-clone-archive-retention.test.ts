import { afterEach, expect, mock, spyOn, test } from 'bun:test'
import * as fs from 'node:fs'
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import {
  pruneReaderCloneArchives,
  READER_CLONE_ARCHIVE_RETENTION_DAYS,
  readerCloneArchiveDirectory,
  STRAY_WORKTREE_ARCHIVE_PROJECT_MARKER,
} from './reader-clone-archive-retention.ts'

const day = 86_400_000

afterEach(() => mock.restore())

test('reader clone archive retention deletes expired archives and keeps newer ones', () => {
  const runsDirectory = join(dir, 'retention-fixture', 'orchestrator', 'runs')
  const archiveRoot = readerCloneArchiveDirectory(runsDirectory)
  const oldArchive = join(archiveRoot, '1-old')
  const newArchive = join(archiveRoot, '2-new')
  const projectArchiveRoot = join(archiveRoot, 'example')
  const oldStrayArchive = join(projectArchiveRoot, 'old-stray')
  const newStrayArchive = join(projectArchiveRoot, 'new-stray')
  const nowMs = 30 * day
  const lines: string[] = []
  mkdirSync(oldArchive, { recursive: true })
  mkdirSync(newArchive, { recursive: true })
  mkdirSync(oldStrayArchive, { recursive: true })
  mkdirSync(newStrayArchive, { recursive: true })
  writeFileSync(join(projectArchiveRoot, STRAY_WORKTREE_ARCHIVE_PROJECT_MARKER), '')
  utimesSync(
    oldArchive,
    new Date(0),
    new Date(nowMs - (READER_CLONE_ARCHIVE_RETENTION_DAYS + 1) * day),
  )
  utimesSync(
    newArchive,
    new Date(0),
    new Date(nowMs - (READER_CLONE_ARCHIVE_RETENTION_DAYS - 1) * day),
  )
  utimesSync(
    oldStrayArchive,
    new Date(0),
    new Date(nowMs - (READER_CLONE_ARCHIVE_RETENTION_DAYS + 1) * day),
  )
  utimesSync(
    newStrayArchive,
    new Date(0),
    new Date(nowMs - (READER_CLONE_ARCHIVE_RETENTION_DAYS - 1) * day),
  )
  try {
    const result = pruneReaderCloneArchives({
      dryRun: false,
      runsDirectory,
      nowMs,
      presentation: {
        log: (...values) => lines.push(values.map(String).join(' ')),
        error: (...values) => lines.push(values.map(String).join(' ')),
      },
    })
    expect(result).toEqual({ deleted: 2, deferred: 0, kept: 2, failed: 0 })
    expect(existsSync(oldArchive)).toBe(false)
    expect(existsSync(newArchive)).toBe(true)
    expect(existsSync(oldStrayArchive)).toBe(false)
    expect(existsSync(newStrayArchive)).toBe(true)
    expect(lines.sort()).toEqual(
      [
        `deleted expired reader clone archive ${oldArchive}`,
        `deleted expired reader clone archive ${oldStrayArchive}`,
      ].sort(),
    )
  } finally {
    rmSync(join(dir, 'retention-fixture'), { recursive: true, force: true })
  }
})

test('reader clone archive retention dry-run only reports expired archives', () => {
  const runsDirectory = join(dir, 'retention-dry-fixture', 'orchestrator', 'runs')
  const archive = join(readerCloneArchiveDirectory(runsDirectory), '1-old')
  const nowMs = 30 * day
  const lines: string[] = []
  mkdirSync(archive, { recursive: true })
  utimesSync(
    archive,
    new Date(0),
    new Date(nowMs - (READER_CLONE_ARCHIVE_RETENTION_DAYS + 1) * day),
  )
  try {
    const result = pruneReaderCloneArchives({
      dryRun: true,
      runsDirectory,
      nowMs,
      presentation: {
        log: (...values) => lines.push(values.map(String).join(' ')),
        error: (...values) => lines.push(values.map(String).join(' ')),
      },
    })
    expect(result.deleted).toBe(1)
    expect(existsSync(archive)).toBe(true)
    expect(lines).toEqual([`would delete expired reader clone archive ${archive}`])
  } finally {
    rmSync(join(dir, 'retention-dry-fixture'), { recursive: true, force: true })
  }
})

test('stray archive retention uses a stamped age even when its mtime is stale', () => {
  const runsDirectory = join(dir, 'retention-stamped-fixture', 'orchestrator', 'runs')
  const projectArchiveRoot = join(readerCloneArchiveDirectory(runsDirectory), 'example')
  const nowMs = Date.parse('2026-10-01T12:00:00.000Z')
  const archive = join(projectArchiveRoot, 'stray-2026-10-01T120000000Z')
  mkdirSync(archive, { recursive: true })
  writeFileSync(join(projectArchiveRoot, STRAY_WORKTREE_ARCHIVE_PROJECT_MARKER), '')
  utimesSync(archive, new Date(0), new Date(0))
  try {
    const result = pruneReaderCloneArchives({
      dryRun: false,
      runsDirectory,
      nowMs,
      presentation: {
        log: () => {},
        error: () => {},
      },
    })
    expect(result).toEqual({ deleted: 0, deferred: 0, kept: 1, failed: 0 })
    expect(existsSync(archive)).toBe(true)
  } finally {
    rmSync(join(dir, 'retention-stamped-fixture'), { recursive: true, force: true })
  }
})

test('whole-clone retention uses a stamped age before a fresh mtime', () => {
  const runsDirectory = join(dir, 'retention-whole-stamped-fixture', 'orchestrator', 'runs')
  const archive = join(readerCloneArchiveDirectory(runsDirectory), 'run-2026-09-01T120000000Z')
  const nowMs = Date.parse('2026-10-01T12:00:00.000Z')
  mkdirSync(archive, { recursive: true })
  utimesSync(archive, new Date(nowMs), new Date(nowMs))
  try {
    const result = pruneReaderCloneArchives({
      dryRun: false,
      runsDirectory,
      nowMs,
      presentation: { log: () => {}, error: () => {} },
    })
    expect(result).toEqual({ deleted: 1, deferred: 0, kept: 0, failed: 0 })
    expect(existsSync(archive)).toBe(false)
  } finally {
    rmSync(join(dir, 'retention-whole-stamped-fixture'), { recursive: true, force: true })
  }
})

test('whole-clone retention falls back to mtime when its name has no stamp', () => {
  const runsDirectory = join(dir, 'retention-whole-unstamped-fixture', 'orchestrator', 'runs')
  const archive = join(readerCloneArchiveDirectory(runsDirectory), 'run-without-stamp')
  const nowMs = 30 * day
  mkdirSync(archive, { recursive: true })
  utimesSync(
    archive,
    new Date(0),
    new Date(nowMs - (READER_CLONE_ARCHIVE_RETENTION_DAYS + 1) * day),
  )
  try {
    const result = pruneReaderCloneArchives({
      dryRun: false,
      runsDirectory,
      nowMs,
      presentation: { log: () => {}, error: () => {} },
    })
    expect(result).toEqual({ deleted: 1, deferred: 0, kept: 0, failed: 0 })
    expect(existsSync(archive)).toBe(false)
  } finally {
    rmSync(join(dir, 'retention-whole-unstamped-fixture'), { recursive: true, force: true })
  }
})

test('reader clone retention reports an unreadable project container and prunes other archives', () => {
  const runsDirectory = join(dir, 'retention-unreadable-fixture', 'orchestrator', 'runs')
  const archiveRoot = readerCloneArchiveDirectory(runsDirectory)
  const unreadable = join(archiveRoot, 'unreadable-project')
  const expired = join(archiveRoot, 'expired-without-stamp')
  const nowMs = 30 * day
  const lines: string[] = []
  mkdirSync(unreadable, { recursive: true })
  writeFileSync(join(unreadable, STRAY_WORKTREE_ARCHIVE_PROJECT_MARKER), '')
  mkdirSync(expired, { recursive: true })
  utimesSync(
    expired,
    new Date(0),
    new Date(nowMs - (READER_CLONE_ARCHIVE_RETENTION_DAYS + 1) * day),
  )
  const realReaddirSync = fs.readdirSync
  spyOn(fs, 'readdirSync').mockImplementation(((path, options) => {
    if (path === unreadable) throw new Error('permission denied')
    return realReaddirSync(path, options as never)
  }) as typeof fs.readdirSync)
  try {
    const result = pruneReaderCloneArchives({
      dryRun: false,
      runsDirectory,
      nowMs,
      presentation: {
        log: (...values) => lines.push(values.map(String).join(' ')),
        error: (...values) => lines.push(values.map(String).join(' ')),
      },
    })
    expect(result).toEqual({ deleted: 1, deferred: 0, kept: 0, failed: 1 })
    expect(existsSync(expired)).toBe(false)
    expect(lines).toContain(
      `could not list reader clone archives in ${unreadable}: permission denied`,
    )
  } finally {
    rmSync(join(dir, 'retention-unreadable-fixture'), { recursive: true, force: true })
  }
})
