// concern: run cursor binding
/** Adapts run lifecycle recording to cursor binding without making cursor refusal fail the run. */

import { recordRunWarning } from '../events.ts'
import { bindRecordedRunCursorArguments } from '../workflow/workflow-cursor-binding.ts'

export async function bindRecordedRunCursor(runRecordId: string): Promise<void> {
  try {
    const result = await bindRecordedRunCursorArguments(runRecordId)
    if (result.action === 'refused') recordRunWarning(runRecordId, result.warning)
  } catch (error) {
    recordRunWarning(
      runRecordId,
      `workflow cursor bound to run ${runRecordId} argument binding failed: ${String((error as Error)?.message ?? error)}`,
    )
  }
}
