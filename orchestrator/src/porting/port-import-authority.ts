// concern: porting
/** Refuses the local-only bulk importer before it can mutate hosted-bound state. */
import { currentRecordWriteDecision } from '../record/record-write-authority.ts'
import { workerStoreWriteRefusal } from '../worker-store-write.ts'

export function assertPortImportAllowed(): void {
  const workerRefusal = workerStoreWriteRefusal('document', 'port import', process.env)
  if (workerRefusal) throw new Error(workerRefusal)
  if (currentRecordWriteDecision() !== 'local-authoritative')
    throw new Error(
      'port import is local-only until the hosted bulk import exists in DEV-1388 S5\n' +
        'condition: this install is configured for a hosted record\n' +
        'cleared by: run the import on a machine with no record bound',
    )
}
