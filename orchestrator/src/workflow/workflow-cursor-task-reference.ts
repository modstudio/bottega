// concern: workflow cursor task reference
/** Guards the natural-key slot held by an older unlinked workflow cursor label. */

import type { Database } from 'bun:sqlite'
import { taskFlowReadStore } from './task-flow-store.ts'

export async function refuseUnlinkedCursorLabelCollision(
  d: Database,
  input: {
    project: string
    workflow: string
    mode: string
    key: string
    taskRecordId?: string | null
  },
): Promise<void> {
  if (input.taskRecordId !== null && input.taskRecordId !== undefined) return
  const occupied = await taskFlowReadStore(d).unlinkedLabelHolder(input)
  if (occupied !== null)
    throw new Error(
      `task key ${input.key} names no task in hub and earlier cursor ${occupied} holds that label; use a real task key`,
    )
}
