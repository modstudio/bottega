// concern: workflow autonomy rendering metadata
/** Carries autonomy notices through workflow composition and step results. */

import type { CursorAutonomyNotice, WorkflowAutonomyResolution } from './autonomy.ts'

export function autonomyNoticeOutput(autonomy?: WorkflowAutonomyResolution): CursorAutonomyNotice {
  if (!autonomy) return {}
  const note = autonomy.note ? { autonomyNote: autonomy.note } : {}
  if (!('cursor' in autonomy)) return note
  return {
    autonomyCursor: autonomy.cursor.id,
    autonomyComposeCommand: autonomy.cursor.composeCommand,
    autonomyDifferences: autonomy.looserLiveDifferences ?? [],
    autonomyUnavailableReason: autonomy.liveUnavailableReason,
    ...note,
  }
}
