// concern: session state sweep
/** Runs both session-owned cleanup passes from the machine sweep. */

import type { CleanupPresentation } from './cleanup.ts'
import { sweepSessionContext } from './cleanup-sweep-context.ts'
import { sweepSessionCursors } from './cleanup-sweep-explore.ts'
import { sweepSessionCloseOutRecords } from './cleanup-sweep-session-close-out.ts'

export async function sweepSessionState(input: {
  project: string | null
  dryRun: boolean
  presentation: CleanupPresentation
}): Promise<boolean> {
  const lifecycle = { ...input, enabled: input.project === null }
  const contextFailed = await sweepSessionContext(lifecycle)
  const closeOutFailed = await sweepSessionCloseOutRecords(lifecycle)
  const cursorFailed = await sweepSessionCursors(input)
  return contextFailed || closeOutFailed || cursorFailed
}
