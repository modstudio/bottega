// concern: record-local-mark
/** Marks an unbound orchestrator store as deliberately local. */

import type { Database } from 'bun:sqlite'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { ORCHESTRATOR_DATABASE_ENV } from '../../../shared/state-directory.ts'
import { db } from '../database/db.ts'
import { storeHasAttachedToHostedRecord } from './install-binding.ts'
import { setRecordLocalByDesign } from './record-local-mark.ts'

export function recordLocalCommand(
  enabled: boolean,
  presentation: { log(value: string): void },
  database: Database = db(),
): void {
  if (enabled && storeHasAttachedToHostedRecord(database)) {
    throw new Error(
      renderRefusal(
        refusal('this store is bound to a hosted record, so it cannot be local by design', {
          kind: 'edit',
          text: `point ${ORCHESTRATOR_DATABASE_ENV} at an unbound store, then rerun record local`,
        }),
      ),
    )
  }
  setRecordLocalByDesign(database, enabled)
  presentation.log(
    enabled ? 'this store is local by design' : 'this store is no longer local by design',
  )
}
