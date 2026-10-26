// concern: workflow cursor task reference
/** Guards the natural-key slot held by an older unlinked workflow cursor label. */

import type { Database } from 'bun:sqlite'

export function refuseUnlinkedCursorLabelCollision(
  d: Database,
  input: { project: string; workflow: string; mode: string; key: string; taskRecordId?: string | null },
): void {
  if (input.taskRecordId !== null && input.taskRecordId !== undefined) return
  const occupied = d
    .query<{ number: number }, [string, string, string, string]>(
      `SELECT number FROM workflow_cursor
       WHERE project_record_id=(SELECT record_id FROM project WHERE name=?)
         AND workflow_slug=? AND mode_slug=? AND workflow_key=? AND instance_id=''
       LIMIT 1`,
    )
    .get(input.project, input.workflow, input.mode, input.key)
  if (occupied)
    throw new Error(
      `task key ${input.key} names no task in hub and earlier cursor ${occupied.number} holds that label; use a real task key`,
    )
}
