// concern: collect-change
/** Owns the monotonic change cursor: reads the counter and publishes the cursor envelope. */

import type { OrchChangeCursorEnvelope } from '../../../shared/orch-contract.ts'
import { db } from '../database/db.ts'

export function collectChangeCursor(): number {
  return (
    db().query<{ value: number }, []>('SELECT value FROM collect_change_counter').get()?.value ?? 0
  )
}

export function publishChangeCursor(snapshot: number | null, log: (line: string) => void): void {
  if (snapshot === null) return
  const envelope: OrchChangeCursorEnvelope = {
    schema_version: 2,
    kind: 'cursor',
    data: { cursor: snapshot },
  }
  log(JSON.stringify(envelope))
}
