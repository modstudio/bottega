// concern: workflow obligation floor persistence
/** Reconstructs the floor semantics retained by a deferred workflow obligation. */

import type { Database } from 'bun:sqlite'
import {
  DEFAULT_EXPECTED_EXIT_CODE,
  DEFAULT_EXPECTED_STATUS,
  type Floor,
  isFloorKind,
  type OpenObligation,
} from './workflow-floor.ts'

export type WorkflowObligationFloorRow = {
  floor: string
  requirePullRequest: boolean | number
  operatorRuling: boolean | number
  expectedExitCode: number
  expectedStatus: string
  floorDeferrable: boolean | number
}

export function floorFromObligationRow(row: WorkflowObligationFloorRow): Floor {
  if (!isFloorKind(row.floor)) throw new Error(`unknown obligation floor kind "${row.floor}"`)
  return {
    kind: row.floor,
    deferrable: row.floorDeferrable === true || row.floorDeferrable === 1,
    expectedExitCode: row.expectedExitCode ?? DEFAULT_EXPECTED_EXIT_CODE,
    expectedStatus: row.expectedStatus ?? DEFAULT_EXPECTED_STATUS,
    requirePullRequest: row.requirePullRequest === true || row.requirePullRequest === 1,
    operatorRuling: row.operatorRuling === true || row.operatorRuling === 1,
  }
}

export function openWorkflowObligations(cursorId: string, d: Database): OpenObligation[] {
  type StoredOpenObligation = Omit<OpenObligation, 'floorDefinition'> & WorkflowObligationFloorRow
  const rows = d
    .query<StoredOpenObligation, [string]>(
      `SELECT record_id id, step_ordinal AS stepOrdinal, step_slug AS stepSlug, floor,
              require_pull_request AS requirePullRequest, operator_ruling AS operatorRuling,
              expected_exit_code AS expectedExitCode, expected_status AS expectedStatus,
              floor_deferrable AS floorDeferrable
         FROM workflow_obligation
        WHERE cursor_record_id=? AND satisfied_at IS NULL AND abandoned_at IS NULL ORDER BY rowid`,
    )
    .all(cursorId)
  return rows.map((row) => ({ ...row, floorDefinition: floorFromObligationRow(row) }))
}
