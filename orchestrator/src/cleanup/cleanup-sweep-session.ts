// concern: session state sweep
/** Runs both session-owned cleanup passes from the machine sweep. */

import type { Database } from 'bun:sqlite'
import type { CleanupPresentation } from './cleanup.ts'
import { sweepSessionContext } from './cleanup-sweep-context.ts'
import { sweepSessionCursors } from './cleanup-sweep-explore.ts'
import { sweepSessionCloseOutRecords } from './cleanup-sweep-session-close-out.ts'

export async function sweepSessionState(input: {
  project: string | null
  dryRun: boolean
  presentation: CleanupPresentation
  database?: Database
  now?: number
}): Promise<boolean> {
  const contextFailed = await sweepSessionContext({
    enabled: input.project === null,
    dryRun: input.dryRun,
    presentation: input.presentation,
    database: input.database,
  })
  const closeOutFailed = await sweepSessionCloseOutRecords({
    enabled: input.project === null,
    dryRun: input.dryRun,
    presentation: input.presentation,
    database: input.database,
    now: input.now,
  })
  const cursorFailed = await sweepSessionCursors({
    project: input.project,
    dryRun: input.dryRun,
    presentation: input.presentation,
    database: input.database,
    now: input.now,
  })
  return contextFailed || closeOutFailed || cursorFailed
}
