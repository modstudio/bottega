// concern: run claim transaction
/** Owns the migration admission check at a run claim's atomic write boundary. */

import { writeTransaction } from '../database/db.ts'
import type { SynchronousResult } from '../synchronous-result.ts'

/** Re-check migration admission in the claim transaction and persist any refusal after rollback. */
export function claimWithMigrationAdmission<T extends SynchronousResult>(
  admission: {
    assertDispatchAllowed(): void
    recordDispatchRefusal?(cause: unknown): void
  },
  claim: () => T,
): T {
  try {
    return writeTransaction(() => {
      admission.assertDispatchAllowed()
      return claim()
    })
  } catch (cause) {
    admission.recordDispatchRefusal?.(cause)
    throw cause
  }
}
