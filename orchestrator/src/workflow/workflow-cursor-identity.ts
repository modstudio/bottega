// concern: workflow-cursor-identity
/** Reads the complete durable identity map for the workflow cursor migration edge. */

import type { Database } from 'bun:sqlite'
import type { WorkflowCursorIdentityRow } from '../../../shared/orch-contract.ts'
import { db } from '../database/db.ts'

export function workflowCursorIdentityMap(database: Database = db()): WorkflowCursorIdentityRow[] {
  return database
    .query<WorkflowCursorIdentityRow, []>(
      'SELECT number,record_id FROM workflow_cursor ORDER BY number',
    )
    .all()
}
