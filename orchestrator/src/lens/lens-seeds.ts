// concern: lens-seeds
/** Owns the built-in lens definitions shared by local initialization and hosted spaces. */
import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record-id.ts'
import { readRecordInstallBinding } from '../record/install-binding.ts'
import {
  BUILT_IN_LENS_DEFAULT_PROFILE,
  BUILT_IN_LENS_SLOTS,
  BUILT_IN_LENSES,
} from './lens-built-ins.ts'

export function seedLenses(local: Database): void {
  if (readRecordInstallBinding(local).bound) return
  for (const [key, title, question, excludes] of BUILT_IN_LENSES) {
    local
      .query(`INSERT OR IGNORE INTO lens
      (record_id,space_id,id,title,question,excludes,slots,version,enabled,requires_execution)
      VALUES (?,NULL,?,?,?,?,?,1,1,0)`)
      .run(newRecordId(), key, title, question, excludes, BUILT_IN_LENS_SLOTS)
    const lens = local
      .query<{ record_id: string }, [string]>(
        'SELECT record_id FROM lens WHERE id=? AND space_id IS NULL',
      )
      .get(key)
    if (!lens) continue
    local
      .query(`INSERT OR IGNORE INTO lens_profile
      (record_id,space_id,lens_record_id,axis,name,version,body,enabled)
      VALUES (?,NULL,?,'framework','default',1,?,1)`)
      .run(newRecordId(), lens.record_id, BUILT_IN_LENS_DEFAULT_PROFILE)
  }
}
