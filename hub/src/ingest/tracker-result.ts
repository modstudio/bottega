import type { Project } from '../db.ts'
import type { TrackerReadMode } from './tracker-read-mode.ts'

export const BACKFILL_RESULT = 'backfill'

export type TrackerResult = {
  project: Project
  tasks: number
  changed: number
  mode?: TrackerReadMode
  deleted?: number
  retired?: number
  unreportedParents?: number
  ambiguousParents?: number
  ambiguousParentKeys?: string[]
  activity?: boolean
  skipped?: string
  error?: string
}

export function trackerLegError(results: TrackerResult[]): string | null {
  const failures = results.filter((result) => result.error)
  return failures.length
    ? failures.map((result) => `${result.project}: ${result.error}`).join('; ')
    : null
}

export const successfulTrackerRead = (result: TrackerResult) =>
  result.project !== BACKFILL_RESULT && !result.error && !result.skipped
