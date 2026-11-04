// concern: record-board-author
/** Validates optional hosted board run and machine authorship. */

import type { SQL } from 'bun'
import { RecordBoardError } from './record-board-contract.ts'

export async function requireOwnedHostedRunAndMachine(
  tx: SQL,
  userId: string,
  input: {
    runId?: string | null
    machineId?: string | null
    runField: string
    machineField?: string
  },
): Promise<void> {
  if (input.runId) {
    const rows = await tx`SELECT started_by_user_id FROM run WHERE id=${input.runId}::uuid`
    if (!rows[0] || String(rows[0].started_by_user_id) !== userId) {
      throw new RecordBoardError(
        `board ${input.runField} is missing, invisible, or not started by this user`,
        400,
      )
    }
  }
  if (input.machineId) {
    const field = input.machineField ?? 'authorMachineId'
    const rows = await tx`SELECT user_id FROM machine WHERE id=${input.machineId}::uuid`
    if (!rows[0] || String(rows[0].user_id) !== userId) {
      throw new RecordBoardError(
        `board ${field} is missing, invisible, or not owned by this user`,
        400,
      )
    }
  }
}
