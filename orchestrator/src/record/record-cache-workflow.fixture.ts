import type { Database } from 'bun:sqlite'
import { applyWorkflowCatalogueRows } from './record-cache-workflow.ts'
import type { RecordWorkflowTable } from './record-workflow-contract.ts'

export function applyWorkflowCatalogueRow(
  local: Database,
  table: RecordWorkflowTable,
  item: Record<string, unknown>,
): void {
  applyWorkflowCatalogueRows(local, [[table, item]])
}
