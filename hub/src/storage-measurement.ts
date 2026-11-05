// concern: hub table storage measurement
/** Measures only the hub SQLite store through its existing handle. */

import type { Database } from 'bun:sqlite'
import { measureSqliteTables } from '../../shared/sqlite-storage-measurement.ts'
import type { TableStorageMeasurement } from '../../shared/storage-lifecycle.ts'

export function measureHubTables(database: Database): TableStorageMeasurement[] {
  return measureSqliteTables(database, 'hub')
}
