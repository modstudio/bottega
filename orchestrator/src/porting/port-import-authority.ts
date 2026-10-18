// concern: porting
/** Selects the local or additive hosted importer before either can mutate state. */
import { currentRecordWriteDecision } from '../record/record-write-authority.ts'
import { workerStoreWriteRefusal } from '../worker-store-write.ts'

export function portImportAuthority(replace: boolean): 'local' | 'hosted' {
  const workerRefusal = workerStoreWriteRefusal('document', 'port import', process.env)
  if (workerRefusal) throw new Error(workerRefusal)
  if (currentRecordWriteDecision() === 'local-authoritative') return 'local'
  if (replace)
    throw new Error(
      'replacing hosted port items is not supported\n' +
        'condition: --replace was requested while a hosted record is configured\n' +
        'cleared by: retire or remove the hosted items individually, or run the import on a machine with no record bound',
    )
  return 'hosted'
}
