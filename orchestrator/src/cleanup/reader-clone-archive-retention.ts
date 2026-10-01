// concern: archived reader clone retention
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { readerCloneArchiveRetentionDecision } from '../close/reader-scratch-release.ts'
import { RUNS_DIR } from '../run/run-artifacts.ts'
import type { CleanupPresentation } from './cleanup.ts'

export const READER_CLONE_ARCHIVE_RETENTION_DAYS = 14

export function readerCloneArchiveDirectory(runsDirectory = RUNS_DIR): string {
  return join(dirname(runsDirectory), 'archive', 'reader-clones')
}

/** Remove expired whole-clone archives, or report exactly what a dry run would remove. */
export function pruneReaderCloneArchives(input: {
  dryRun: boolean
  presentation: Pick<CleanupPresentation, 'log' | 'error'>
  runsDirectory?: string
  nowMs?: number
}): { deleted: number; kept: number; failed: number } {
  const root = readerCloneArchiveDirectory(input.runsDirectory)
  const counts = { deleted: 0, kept: 0, failed: 0 }
  if (!existsSync(root)) return counts
  const nowMs = input.nowMs ?? Date.now()
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    try {
      const decision = readerCloneArchiveRetentionDecision({
        nowMs,
        modifiedMs: statSync(path).mtimeMs,
        retentionDays: READER_CLONE_ARCHIVE_RETENTION_DAYS,
      })
      if (decision === 'keep') {
        counts.kept++
        continue
      }
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
