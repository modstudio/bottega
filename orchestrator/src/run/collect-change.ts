// concern: collect-change
/** Owns the monotonic change cursor: reads the counter and publishes the cursor envelope. */

import type { OrchChangeCursorEnvelope } from '../../../shared/orch-contract.ts'
export function publishChangeCursor(snapshot: string | null, log: (line: string) => void): void {
  if (snapshot === null) return
  const envelope: OrchChangeCursorEnvelope = {
    schema_version: 2,
    kind: 'cursor',
    data: { cursor: snapshot },
  }
  log(JSON.stringify(envelope))
}
