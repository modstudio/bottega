// concern: orchestrator table storage measurement
/** Measures only the orchestrator SQLite store through its existing handle. */

import type { Database } from 'bun:sqlite'
import { measureSqliteTables } from '../../../shared/sqlite-storage-measurement.ts'
import type { TableStorageMeasurement } from '../../../shared/storage-lifecycle.ts'

export function measureOrchestratorTables(database: Database): TableStorageMeasurement[] {
  return measureSqliteTables(database, 'orchestrator')
}
