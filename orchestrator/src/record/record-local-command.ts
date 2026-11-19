// concern: record-install-binding
/** Marks an unbound orchestrator store as deliberately local. */

import type { Database } from 'bun:sqlite'
import { PLATFORM_SLUG } from '../../../shared/brand.ts'
import { refusal, renderRefusal } from '../../../shared/refusal.ts'
import { db } from '../database/db.ts'
import { readRecordInstallBinding, setRecordLocalByDesign } from './install-binding.ts'

export function recordLocalCommand(
  enabled: boolean,
  presentation: { log(value: string): void },
  database: Database = db(),
): void {
  if (readRecordInstallBinding(database).bound) {
    throw new Error(
      renderRefusal(
        refusal('this store is bound to a hosted record', {
          kind: 'command',
          argv: [PLATFORM_SLUG, 'record', 'use', '<address>'],
        }),
      ),
    )
  }
  setRecordLocalByDesign(database, enabled)
  presentation.log(
    enabled ? 'this store is local by design' : 'this store is no longer local by design',
  )
}
