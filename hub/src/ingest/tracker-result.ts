import {
  dropUnregisteredTrackerCollectorStates,
  recordTrackerCollectorState,
} from '../collector-leg-state.ts'
import { type Project, writeTransaction } from '../db.ts'
import type { TrackerReadMode } from './tracker-read-mode.ts'
import { trackerReadKey } from './tracker-read-state.ts'

const BACKFILL_RESULT = 'backfill'

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

export function finishTrackerResults(
  results: { result: TrackerResult; filled: number }[],
  at: string,
  registeredProjects: readonly Project[],
): TrackerResult[] {
  const filled = results.reduce((sum, item) => sum + item.filled, 0)
  const out = results.map((item) => item.result)
  if (filled) out.push({ project: BACKFILL_RESULT, tasks: filled, changed: 0, activity: true })
  for (const result of out) recordTrackerCollectorState(result, at)
  dropUnregisteredTrackerCollectorStates(registeredProjects)
  const successfulProjects = out.filter(successfulTrackerRead)
  if (successfulProjects.length)
    writeTransaction((conn) => {
      const write = conn.query(
        `INSERT INTO setting (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      for (const result of successfulProjects) write.run(trackerReadKey(result.project), at)
    })
  if (!trackerLegError(out))
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO setting (key, value) VALUES ('collect.trackers.at', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(JSON.stringify(at)),
    )
  return out
}
