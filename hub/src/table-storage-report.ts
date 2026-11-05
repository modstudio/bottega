// concern: hub table storage report
/** Measures hub-local tables without opening another concern's store. */

import { db } from './db.ts'
import { measureHubTables } from './storage-measurement.ts'

export function hubTableStorage() {
  return { measurements: measureHubTables(db()) }
}
