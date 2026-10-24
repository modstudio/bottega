// concern: record-install-binding
/** Owns the monotonic local fact that this store has attached to a hosted record. */

import type { Database } from 'bun:sqlite'

export type RecordInstallBinding =
  | { bound: false; boundAt: null }
  | { bound: true; boundAt: string }

export const NEVER_BOUND: RecordInstallBinding = { bound: false, boundAt: null }

export function readRecordInstallBinding(database: Database): RecordInstallBinding {
  const row = database
    .query<{ bound_at: string }, []>('SELECT bound_at FROM record_install_binding WHERE id = 1')
    .get()
  return row ? { bound: true, boundAt: row.bound_at } : NEVER_BOUND
}
