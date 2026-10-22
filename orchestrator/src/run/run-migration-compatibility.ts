// concern: run migration compatibility
/** Binds database schema refusals to a coordinator's durable artifact directory. */

import { enableSchemaReload } from '../database/db.ts'
import { recordCoordinatorCause } from './run-coordinator-log.ts'

export function enableRunSchemaReload(runId?: string): void {
  enableSchemaReload(() => {}, runId ? (cause) => recordCoordinatorCause(runId, cause) : undefined)
}

export function claimedOutputAfterSchemaReload(runId: string, outputPath: string): string {
  enableRunSchemaReload(runId)
  return outputPath
}
