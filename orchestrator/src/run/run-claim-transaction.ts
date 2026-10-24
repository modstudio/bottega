// concern: run claim transaction
/** Owns the migration admission check at a run claim's atomic write boundary. */

import { writeTransaction } from '../database/db.ts'

/** Re-check migration admission in the claim transaction and persist any refusal after rollback. */
export function claimWithMigrationAdmission<T>(
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
