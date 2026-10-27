// concern: archived reader clone retention
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  READER_CLONE_ARCHIVE_DELETIONS_PER_SWEEP,
  type ReaderCloneArchive,
  readerCloneArchivePruneDecision,
} from '../close/reader-scratch-release.ts'
import { RUNS_DIR } from '../run/run-artifacts.ts'
import type { CleanupPresentation } from './cleanup.ts'

export const READER_CLONE_ARCHIVE_RETENTION_DAYS = 14
export const STRAY_WORKTREE_ARCHIVE_PROJECT_MARKER = '.stray-worktree-archives'

export function readerCloneArchiveDirectory(runsDirectory = RUNS_DIR): string {
  return join(dirname(runsDirectory), 'archive', 'reader-clones')
}

type ArchivedDirectory = { path: string; archivedMs: number | null }

function strayArchiveTimestamp(path: string): number | null {
  const match = path.match(/-(\d{4}-\d{2}-\d{2}T)(\d{2})(\d{2})(\d{2})(\d{3})Z$/)
  if (!match) return null
  const archivedMs = Date.parse(`${match[1]}${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`)
  return Number.isNaN(archivedMs) ? null : archivedMs
}

function archivedDirectories(root: string): ArchivedDirectory[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return []
    const path = join(root, entry.name)
    // Stray directories sit one level below a marked project container. Every
    // unmarked directory retains the original whole-reader-clone layout.
    if (!existsSync(join(path, STRAY_WORKTREE_ARCHIVE_PROJECT_MARKER)))
      return [{ path, archivedMs: null }]
    return readdirSync(path, { withFileTypes: true })
      .filter((child) => child.isDirectory())
      .map((child) => {
        const childPath = join(path, child.name)
        return { path: childPath, archivedMs: strayArchiveTimestamp(childPath) }
      })
  })
}

/** Remove expired whole-clone archives, or report exactly what a dry run would remove. */
export function pruneReaderCloneArchives(input: {
  dryRun: boolean
  presentation: Pick<CleanupPresentation, 'log' | 'error'>
  runsDirectory?: string
  nowMs?: number
}): { deleted: number; deferred: number; kept: number; failed: number } {
  const root = readerCloneArchiveDirectory(input.runsDirectory)
  const counts = { deleted: 0, deferred: 0, kept: 0, failed: 0 }
  if (!existsSync(root)) return counts
  const nowMs = input.nowMs ?? Date.now()
  const archives: ReaderCloneArchive[] = []
  for (const archive of archivedDirectories(root)) {
    try {
      archives.push({
        path: archive.path,
        archivedMs: archive.archivedMs ?? statSync(archive.path).mtimeMs,
      })
    } catch (error) {
      counts.failed++
      input.presentation.error(
        `could not read the archived time of reader clone archive ${archive.path}: ${String((error as Error).message ?? error)}`,
      )
    }
  }
  const decision = readerCloneArchivePruneDecision({
    archives,
    nowMs,
    retentionDays: READER_CLONE_ARCHIVE_RETENTION_DAYS,
    deletionCap: READER_CLONE_ARCHIVE_DELETIONS_PER_SWEEP,
  })
  counts.deferred = decision.deferred
  counts.kept = archives.length - decision.delete.length - decision.deferred
  if (counts.deferred > 0)
    input.presentation.log(
      `deferred ${counts.deferred} expired reader clone archives because the per-sweep deletion limit is ${READER_CLONE_ARCHIVE_DELETIONS_PER_SWEEP}`,
    )
  for (const path of decision.delete) {
    try {
      if (input.dryRun) input.presentation.log(`would delete expired reader clone archive ${path}`)
      else {
        rmSync(path, { recursive: true })
        input.presentation.log(`deleted expired reader clone archive ${path}`)
      }
      counts.deleted++
    } catch (error) {
      counts.failed++
      input.presentation.error(
        `could not delete reader clone archive ${path}: ${String((error as Error).message ?? error)}`,
      )
    }
  }
  return counts
}
