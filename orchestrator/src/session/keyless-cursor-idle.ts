// concern: keyless cursor idle reporting
/** Computes the shared idle duration and label used by session reports. */

import { idleLabel, idleMsSince } from '../events.ts'

export type KeylessCursorIdle = { ms: number; label: string }

export function keylessCursorIdle(updatedAt: string, now = Date.now()): KeylessCursorIdle | null {
  const ms = idleMsSince(updatedAt, updatedAt, now)
  const label = idleLabel(updatedAt, updatedAt, now, 0)
  return ms === null || label === null ? null : { ms, label }
}
