// concern: record-install-binding
/** Owns the monotonic local fact that this store has attached to a hosted record. */

import type { Database } from 'bun:sqlite'

export type RecordInstallBinding =
  | { bound: false; boundAt: null; recordOrigin: null }
  | { bound: true; boundAt: string; recordOrigin: string | null }

export const NEVER_BOUND: RecordInstallBinding = {
  bound: false,
  boundAt: null,
  recordOrigin: null,
}

export function recordInstallBindingHasOrigin(database: Database): boolean {
  return database
    .query<{ name: string }, []>("SELECT name FROM pragma_table_info('record_install_binding')")
    .all()
    .some(({ name }) => name === 'record_origin')
}

export function readRecordInstallBinding(database: Database): RecordInstallBinding {
  const hasOrigin = recordInstallBindingHasOrigin(database)
  if (!hasOrigin) {
    const legacy = database
      .query<{ bound_at: string }, []>('SELECT bound_at FROM record_install_binding WHERE id = 1')
      .get()
    return legacy ? { bound: true, boundAt: legacy.bound_at, recordOrigin: null } : NEVER_BOUND
  }
  const row = database
    .query<{ bound_at: string; record_origin: string | null }, []>(
      'SELECT bound_at,record_origin FROM record_install_binding WHERE id = 1',
    )
    .get()
  return row ? { bound: true, boundAt: row.bound_at, recordOrigin: row.record_origin } : NEVER_BOUND
}
