// concern: workflow cursor task reference
/** Guards the natural-key slot held by an older unlinked workflow cursor label. */

import type { Database } from 'bun:sqlite'
import { taskFlowStore } from './task-flow-store.ts'

export function refuseUnlinkedCursorLabelCollision(
  d: Database,
  input: {
    project: string
    workflow: string
    mode: string
    key: string
    taskRecordId?: string | null
  },
): void {
  if (input.taskRecordId !== null && input.taskRecordId !== undefined) return
  const occupied = taskFlowStore(d).unlinkedLabelHolder(input)
  if (occupied !== null)
    throw new Error(
      `task key ${input.key} names no task in hub and earlier cursor ${occupied} holds that label; use a real task key`,
    )
}
