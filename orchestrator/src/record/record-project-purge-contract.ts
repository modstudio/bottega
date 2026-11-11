// concern: record-project-purge-contract
import type { RemovalReport as RecordRemovalReport } from '../../../shared/removal-report.ts'

/** Stable hosted project-purge response shape. */
export class RecordProjectPurgeError extends Error {
  readonly status = 422
}

export type RecordProjectPurgeResult = {
  nothingToRemove: boolean
  tables: RecordRemovalReport
}
