// concern: workflow obligation floor persistence
/** Reconstructs the floor semantics retained by a deferred workflow obligation. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
import type { RecordTaskFlowClient } from '../record/record-api-client-task-flow.ts'
import { taskFlowReadStore } from './task-flow-store.ts'
import { type Floor, isFloorKind, type OpenObligation } from './workflow-floor.ts'

export type WorkflowObligationFloorRow = {
  id: string
  floor: string
  require_pull_request: boolean | number
  operator_ruling: boolean | number
  expected_exit_code: number
  expected_status: string
  floor_deferrable: boolean | number
  cursor_number: number
}

export function floorFromObligationRow(row: WorkflowObligationFloorRow): Floor {
  if (!isFloorKind(row.floor))
    throw new Error(
      `obligation ${row.id} has unknown floor kind "${row.floor}"; this ${PLATFORM_NAME} binary does not know that floor kind; run \`${PLATFORM_SLUG} machine update\` when a newer ${PLATFORM_NAME} recorded the obligation, otherwise abandon its cursor with \`${PLATFORM_SLUG} workflow abandon --cursor ${row.cursor_number}\``,
    )
  return {
    kind: row.floor,
    deferrable: row.floor_deferrable === true || row.floor_deferrable === 1,
    expectedExitCode: row.expected_exit_code,
    expectedStatus: row.expected_status,
    requirePullRequest: row.require_pull_request === true || row.require_pull_request === 1,
    operatorRuling: row.operator_ruling === true || row.operator_ruling === 1,
  }
}

export async function openWorkflowObligations(
  cursorId: string,
  d: Database,
  client?: RecordTaskFlowClient,
): Promise<OpenObligation[]> {
  const rows = await taskFlowReadStore(d, client).openObligations(cursorId)
  return rows.map((row) => ({
    id: row.id,
    stepOrdinal: row.stepOrdinal,
    stepSlug: row.stepSlug,
    floorDefinition: floorFromObligationRow(row),
  }))
}
