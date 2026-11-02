// concern: workflow obligation floor persistence
/** Reconstructs the floor semantics retained by a deferred workflow obligation. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_NAME, PLATFORM_SLUG } from '../../../shared/brand.ts'
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

export const WORKFLOW_OBLIGATION_FLOOR_COLUMNS =
  'record_id AS id, floor, require_pull_request, operator_ruling, expected_exit_code, expected_status, floor_deferrable, (SELECT number FROM workflow_cursor WHERE workflow_cursor.record_id=workflow_obligation.cursor_record_id) AS cursor_number'

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

export function openWorkflowObligations(cursorId: string, d: Database): OpenObligation[] {
  type StoredOpenObligation = WorkflowObligationFloorRow & {
    stepOrdinal: number
    stepSlug: string
  }
  const rows = d
    .query<StoredOpenObligation, [string]>(
      `SELECT ${WORKFLOW_OBLIGATION_FLOOR_COLUMNS},
              step_ordinal AS stepOrdinal, step_slug AS stepSlug
         FROM workflow_obligation
        WHERE cursor_record_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL ORDER BY rowid`,
    )
    .all(cursorId)
  return rows.map((row) => ({
    id: row.id,
    stepOrdinal: row.stepOrdinal,
    stepSlug: row.stepSlug,
    floorDefinition: floorFromObligationRow(row),
  }))
}
