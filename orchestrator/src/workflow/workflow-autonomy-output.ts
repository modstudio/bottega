// concern: workflow autonomy rendering metadata
/** Carries cursor-only autonomy notices through workflow composition and step results. */

import type { CursorAutonomyNotice, WorkflowAutonomyResolution } from './autonomy.ts'

export function cursorAutonomyOutput(autonomy?: WorkflowAutonomyResolution): CursorAutonomyNotice {
  if (!autonomy || !('cursor' in autonomy)) return {}
  return {
    autonomyCursor: autonomy.cursor.id,
    autonomyComposeCommand: autonomy.cursor.composeCommand,
    autonomyDifferences: autonomy.looserLiveDifferences ?? [],
    autonomyUnavailableReason: autonomy.liveUnavailableReason,
  }
}
