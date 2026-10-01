import { expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { dir } from '../../test/fixtures/store.ts'
import {
  pruneReaderCloneArchives,
  READER_CLONE_ARCHIVE_RETENTION_DAYS,
  readerCloneArchiveDirectory,
} from './reader-clone-archive-retention.ts'

test('reader clone archive retention deletes expired archives and keeps newer ones', () => {
  const runsDirectory = join(dir, 'retention-fixture', 'orchestrator', 'runs')
  const archiveRoot = readerCloneArchiveDirectory(runsDirectory)
  const oldArchive = join(archiveRoot, '1-old')
  const newArchive = join(archiveRoot, '2-new')
  const day = 86_400_000
  const nowMs = 30 * day
  const lines: string[] = []
  mkdirSync(oldArchive, { recursive: true })
  mkdirSync(newArchive, { recursive: true })
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
    expect(result).toEqual({ deleted: 1, kept: 1, failed: 0 })
    expect(existsSync(oldArchive)).toBe(false)
    expect(existsSync(newArchive)).toBe(true)
    expect(lines).toEqual([`deleted expired reader clone archive ${oldArchive}`])
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
