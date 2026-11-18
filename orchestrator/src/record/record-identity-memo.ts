// concern: record-api-client
/** Shares hosted record identity reads between real-transport clients in one process. */

import { readRecordSessionStamp, type RecordSessionStamp } from '../../../shared/record-session.ts'
import type { RecordIdentity } from './record-auth.ts'

export const RECORD_IDENTITY_MEMO_MAX_AGE_MS = 60_000

const MEMO_KEY = Symbol.for('orch.record-identity-memo')
type MemoEntry = {
  stamp: RecordSessionStamp
  startedAt: number
  read: Promise<RecordIdentity>
}
type MemoSlot = { byBaseUrl: Map<string, MemoEntry> }

function memoSlot(): MemoSlot {
  const holder = globalThis as typeof globalThis & { [MEMO_KEY]?: MemoSlot }
  const existing = holder[MEMO_KEY]
  if (existing) return existing
  const created = { byBaseUrl: new Map<string, MemoEntry>() }
  holder[MEMO_KEY] = created
  return created
}

export function memoizedRecordIdentity(
  baseUrl: string,
  load: () => Promise<RecordIdentity>,
  now: () => number = Date.now,
): Promise<RecordIdentity> {
  const slot = memoSlot()
  const stamp = readRecordSessionStamp()
  const at = now()
  const current = slot.byBaseUrl.get(baseUrl)
  if (
    current &&
    current.stamp === stamp &&
    at - current.startedAt < RECORD_IDENTITY_MEMO_MAX_AGE_MS
  )
    return current.read
  const read = load().catch((error) => {
    if (slot.byBaseUrl.get(baseUrl)?.read === read) slot.byBaseUrl.delete(baseUrl)
    throw error
  })
  slot.byBaseUrl.set(baseUrl, { stamp, startedAt: at, read })
  return read
}

export function forgetRecordIdentityMemo(): void {
  memoSlot().byBaseUrl.clear()
}
