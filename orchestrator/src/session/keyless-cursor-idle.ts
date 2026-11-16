// concern: keyless cursor idle reporting
/** Computes the shared idle duration and label used by session reports. */

import { idleAge } from '../events.ts'

export type KeylessCursorIdle = { ms: number; label: string }
export const KEYLESS_CURSOR_IDLE_MS = 60 * 60 * 1000

export function keylessCursorIdle(updatedAt: string, now = Date.now()): KeylessCursorIdle | null {
  return idleAge(updatedAt, updatedAt, now)
}
