// concern: orchestrator table storage report
/** Composes orchestrator-local and hosted catalog measurements without opening hub.db. */

import type {
  TableStorageMeasurement,
  TableStorageReport,
} from '../../../shared/storage-lifecycle.ts'
import { db } from '../database/db.ts'
import { measureOrchestratorTables } from '../database/storage-measurement.ts'
import { recordApiClient } from '../record/record-api-client.ts'

export type OrchestratorTableStorage = {
  measurements: TableStorageMeasurement[]
  missing: TableStorageReport['missing']
}

export async function orchestratorTableStorage(): Promise<OrchestratorTableStorage> {
  const local = measureOrchestratorTables(db())
  try {
    const hosted = await recordApiClient().storage()
    return { measurements: [...local, ...hosted.tables], missing: [] }
  } catch (error) {
    return {
      measurements: local,
      missing: [
        { store: 'hosted', reason: error instanceof Error ? error.message : String(error) },
      ],
    }
  }
}
