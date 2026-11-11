// concern: workflow-cursor-identity
/** Reads the complete durable identity map for the workflow cursor migration edge. */

import type { Database } from 'bun:sqlite'
import type { WorkflowCursorIdentityRow } from '../../../shared/orch-contract.ts'
import { db } from '../database/db.ts'
import { taskFlowStore } from './task-flow-store.ts'

export function workflowCursorIdentityMap(database: Database = db()): WorkflowCursorIdentityRow[] {
  return taskFlowStore(database).stageIdentityMap()
}
