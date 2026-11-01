// concern: workflow obligation floor persistence
/** Reconstructs the floor semantics retained by a deferred workflow obligation. */

import {
  DEFAULT_EXPECTED_EXIT_CODE,
  DEFAULT_EXPECTED_STATUS,
  type Floor,
  isFloorKind,
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
