// concern: session state sweep
/** Runs both session-owned cleanup passes from the machine sweep. */

import type { CleanupPresentation } from './cleanup.ts'
import { sweepSessionContext } from './cleanup-sweep-context.ts'
import { sweepSessionCloseOutRecords } from './cleanup-sweep-session-close-out.ts'

export async function sweepSessionState(input: {
  enabled: boolean
  dryRun: boolean
  presentation: CleanupPresentation
}): Promise<boolean> {
  const contextFailed = await sweepSessionContext(input)
  const closeOutFailed = await sweepSessionCloseOutRecords(input)
  return contextFailed || closeOutFailed
}
