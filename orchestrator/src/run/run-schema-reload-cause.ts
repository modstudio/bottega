// concern: run schema reload cause
/** Binds database schema refusals to a coordinator's durable artifact directory. */

import { enableSchemaReload } from '../database/db.ts'
import { recordCoordinatorCause } from './run-coordinator-log.ts'

export function enableRunSchemaReload(runId?: string): void {
  enableSchemaReload(undefined, runId ? (cause) => recordCoordinatorCause(runId, cause) : undefined)
}
