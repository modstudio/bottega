// concern: keyless cursor idle reporting
/** Computes the shared idle duration and label used by session reports. */

import { idleAge } from '../events.ts'

export type KeylessCursorIdle = { ms: number; label: string }
export const KEYLESS_CURSOR_IDLE_MS = 60 * 60 * 1000

export function keylessCursorIdle(updatedAt: string, now = Date.now()): KeylessCursorIdle | null {
  return idleAge(updatedAt, updatedAt, now)
}

export function idleKeylessCursor(
  cursor: { key: string | null; questionNumber: number | null; updatedAt: string },
  now = Date.now(),
): KeylessCursorIdle | null {
  if (cursor.key || cursor.questionNumber !== null) return null
  const idle = keylessCursorIdle(cursor.updatedAt, now)
  return idle && idle.ms >= KEYLESS_CURSOR_IDLE_MS ? idle : null
}
