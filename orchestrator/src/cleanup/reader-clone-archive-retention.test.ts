import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import {
  pruneReaderCloneArchives,
  READER_CLONE_ARCHIVE_RETENTION_DAYS,
  readerCloneArchiveDirectory,
  STRAY_WORKTREE_ARCHIVE_PROJECT_MARKER,
} from './reader-clone-archive-retention.ts'

test('reader clone archive retention deletes expired archives and keeps newer ones', () => {
  const runsDirectory = join(dir, 'retention-fixture', 'orchestrator', 'runs')
  const archiveRoot = readerCloneArchiveDirectory(runsDirectory)
  const oldArchive = join(archiveRoot, '1-old')
  const newArchive = join(archiveRoot, '2-new')
  const projectArchiveRoot = join(archiveRoot, 'example')
  const oldStrayArchive = join(projectArchiveRoot, 'old-stray')
  const newStrayArchive = join(projectArchiveRoot, 'new-stray')
  const day = 86_400_000
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
    expect(result).toEqual({ deleted: 2, kept: 2, failed: 0 })
    expect(existsSync(oldArchive)).toBe(false)
    expect(existsSync(newArchive)).toBe(true)
    expect(existsSync(oldStrayArchive)).toBe(false)
    expect(existsSync(newStrayArchive)).toBe(true)
    expect(lines).toEqual([
      `deleted expired reader clone archive ${oldArchive}`,
      `deleted expired reader clone archive ${oldStrayArchive}`,
    ])
  } finally {
    rmSync(join(dir, 'retention-fixture'), { recursive: true, force: true })
  }
})

test('reader clone archive retention dry-run only reports expired archives', () => {
  const runsDirectory = join(dir, 'retention-dry-fixture', 'orchestrator', 'runs')
  const archive = join(readerCloneArchiveDirectory(runsDirectory), '1-old')
  const day = 86_400_000
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
    expect(result).toEqual({ deleted: 0, kept: 1, failed: 0 })
    expect(existsSync(archive)).toBe(true)
  } finally {
    rmSync(join(dir, 'retention-stamped-fixture'), { recursive: true, force: true })
  }
})
