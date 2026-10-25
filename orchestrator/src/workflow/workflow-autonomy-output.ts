// concern: workflow autonomy rendering metadata
/** Carries cursor-only autonomy notices through workflow composition and step results. */

import type { WorkflowAutonomyResolution } from './autonomy.ts'

export function cursorAutonomyOutput(autonomy?: WorkflowAutonomyResolution) {
  if (!autonomy || !('cursor' in autonomy)) return {}
  return {
    autonomyComposeCommand: autonomy.cursor.composeCommand,
    autonomyDifferences: autonomy.looserLiveDifferences ?? [],
    autonomyUnavailableReason: autonomy.liveUnavailableReason,
  }
}
