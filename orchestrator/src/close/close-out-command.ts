// concern: close-out
/** Owns explicit close-out presentation and exit mapping. Must not know CLI grammar. */

import { writableDb } from '../database/db.ts'
import { closeOutRun } from './close-out.ts'

export function closeOutCommand(
  id: number,
  nonBlocking: boolean,
  presentation: { log(value: string): void; setExitCode(code: number): void },
): void {
  writableDb()
  const result = closeOutRun(id, { intent: 'explicit', lockTimeoutMs: nonBlocking ? 0 : undefined })
  const reportOutcome = result.reportOutcome ?? result.outcome
  presentation.log(
    `${reportOutcome} run ${result.runId}${result.worktree ? ` ${result.worktree}` : ''}: ${result.detail}`,
  )
  if (reportOutcome === 'held' || reportOutcome === 'failed') presentation.setExitCode(1)
}
