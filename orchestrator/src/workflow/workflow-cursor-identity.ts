// concern: workflow-cursor-identity
/** Reads the complete durable identity map for the workflow cursor migration edge. */

import type { Database } from 'bun:sqlite'
import type { WorkflowCursorIdentityRow } from '../../../shared/orch-contract.ts'
import { db } from '../database/db.ts'
import { taskFlowReadStore } from './task-flow-store.ts'

export async function workflowCursorIdentityMap(
  database: Database = db(),
): Promise<WorkflowCursorIdentityRow[]> {
  return await taskFlowReadStore(database).stageIdentityMap()
}
