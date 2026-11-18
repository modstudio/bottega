// concern: run cursor binding
/** Adapts run lifecycle recording to cursor binding without making cursor refusal fail the run. */

import { recordRunWarning } from '../events.ts'
import { db } from '../database/db.ts'
import { bindRecordedRunCursorArguments } from '../workflow/workflow-cursor-binding.ts'

export async function bindRecordedRunCursor(runRecordId: string): Promise<void> {
  try {
    const result = await bindRecordedRunCursorArguments(runRecordId)
    if (result.action === 'refused') recordRunWarning(runRecordId, result.warning)
  } catch (error) {
    const cursor = db()
      .query<{ number: number }, [string]>(
        `SELECT workflow_cursor.number FROM run
         JOIN workflow_cursor ON workflow_cursor.record_id=run.cursor_record_id
         WHERE run.record_id=?`,
      )
      .get(runRecordId)?.number
    recordRunWarning(
      runRecordId,
      `workflow cursor ${cursor ?? 'binding'} argument binding failed: ${String((error as Error)?.message ?? error)}`,
    )
  }
}
