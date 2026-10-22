// concern: close-out
/** Owns explicit close-out presentation and exit mapping. Must not know CLI grammar. */

import { writableDb } from '../database/db.ts'
import { closeOutRun } from './close-out.ts'
import { annotateHeldLandingInFlight } from './close-out-in-flight.ts'
import { formatCloseOutReport } from './close-out-report.ts'

export function closeOutCommand(
  id: string,
  nonBlocking: boolean,
  presentation: { log(value: string): void; setExitCode(code: number): void },
): void {
  writableDb()
  const result = annotateHeldLandingInFlight(
    closeOutRun(id, { intent: 'explicit', lockTimeoutMs: nonBlocking ? 0 : undefined }),
  )
  const reportOutcome = result.reportOutcome ?? result.outcome
  presentation.log(formatCloseOutReport(result))
  if (reportOutcome === 'held' || reportOutcome === 'failed') presentation.setExitCode(1)
}
