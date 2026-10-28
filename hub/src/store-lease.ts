import type { Database } from 'bun:sqlite'
import { db, writeTransaction } from './db.ts'

export type StoredLeaseStartFacts = {
  leaseHolder: string | null
  intentHolder: string | null
  intentUntil: number | null
  now: number
}

type StoredLeaseValue = { holder: string; until: number; since?: number }

export type StoredLeaseSnapshot = {
  holder: string
  since: number | null
  until: number
}

function storedValue(value: string | undefined): StoredLeaseValue | null {
  if (value === undefined) return null
  try {
    const parsed = JSON.parse(value) as Partial<StoredLeaseValue>
    return typeof parsed.holder === 'string' && typeof parsed.until === 'number'
      ? {
          holder: parsed.holder,
          until: parsed.until,
          ...(typeof parsed.since === 'number' ? { since: parsed.since } : {}),
        }
      : null
  } catch {
    return null
  }
}

function takeSettingRow(
  conn: Database,
  key: string,
  value: StoredLeaseValue,
  now: number,
  holder: string,
): void {
  conn
    .query(
      `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value
        WHERE COALESCE(json_extract(setting.value, '$.until'), 0) <= ?
           OR json_extract(setting.value, '$.holder') = ?`,
    )
    .run(key, JSON.stringify(value), now, holder)
}

/** A renewal preserves the original acquisition instant, including an unknown legacy instant. */
function renewedStoredLeaseValue(
  current: StoredLeaseValue | null,
  holder: string,
  until: number,
  now: number,
): StoredLeaseValue {
  if (current?.holder !== holder || current.until <= now) return { holder, until, since: now }
  return { holder, until, ...(current.since === undefined ? {} : { since: current.since }) }
}

export function acquireStoredLease(
  key: string,
  holder: string,
  durationMs: number,
  trackSince = false,
): boolean {
  const now = Date.now()
  const row = writeTransaction((conn) => {
    const current = storedValue(
      conn.query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key=?`).get(key)
        ?.value,
    )
    takeSettingRow(
      conn,
      key,
      trackSince
        ? renewedStoredLeaseValue(current, holder, now + durationMs, now)
        : { holder, until: now + durationMs },
      now,
      holder,
    )
    return conn.query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key=?`).get(key)
  })
  try {
    return (JSON.parse(row!.value) as { holder: string }).holder === holder
  } catch {
    return false
  }
}

/** Atomically apply a caller's start decision and acquire its stored lease. */
export function acquireStoredLeaseWhen(
  key: string,
  intentKey: string,
  holder: string,
  durationMs: number,
  mayStart: (facts: StoredLeaseStartFacts) => boolean,
  trackSince = false,
): boolean {
  const now = Date.now()
  return writeTransaction((conn) => {
    const rows = conn
      .query<{ key: string; value: string }, [string, string]>(
        `SELECT key, value FROM setting WHERE key IN (?, ?)`,
      )
      .all(key, intentKey)
    const lease = storedValue(rows.find((row) => row.key === key)?.value)
    const intent = storedValue(rows.find((row) => row.key === intentKey)?.value)
    if (
      !mayStart({
        leaseHolder: lease && lease.until > now ? lease.holder : null,
        intentHolder: intent?.holder ?? null,
        intentUntil: intent?.until ?? null,
        now,
      })
    )
      return false
    takeSettingRow(
      conn,
      key,
      trackSince
        ? renewedStoredLeaseValue(lease, holder, now + durationMs, now)
        : { holder, until: now + durationMs },
      now,
      holder,
    )
    const acquired = conn
      .query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key=?`)
      .get(key)
    return storedValue(acquired?.value)?.holder === holder
  })
}

/** Claim the single waiter slot unless another unexpired waiter already owns it. */
export function acquireStoredLeaseIntent(key: string, holder: string, until: number): boolean {
  const now = Date.now()
  return writeTransaction((conn) => {
    takeSettingRow(conn, key, { holder, until }, now, holder)
    const intent = conn
      .query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key=?`)
      .get(key)
    return storedValue(intent?.value)?.holder === holder
  })
}

export function releaseStoredLease(key: string, holder: string): void {
  writeTransaction((conn) =>
    conn
      .query(`DELETE FROM setting WHERE key=? AND json_extract(value, '$.holder')=?`)
      .run(key, holder),
  )
}

export function storedLeaseHolder(key: string): string | null {
  return storedLeaseSnapshot(key)?.holder ?? null
}

/** Read an unexpired lease without upgrading the store handle or repairing legacy values. */
export function storedLeaseSnapshot(key: string, now = Date.now()): StoredLeaseSnapshot | null {
  const row = db()
    .query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key=?`)
    .get(key)
  const lease = storedValue(row?.value)
  if (!lease || lease.until <= now) return null
  return {
    holder: lease.holder,
    since: lease.since ?? null,
    until: lease.until,
  }
}

export type StoredLeaseGuard = {
  assertHeld(afterLeg?: string): void
}

export class StoredLeaseLostError extends Error {
  readonly heldBy: string | null

  constructor(
    heldBy: string | null,
    message: (heldBy: string | null, afterLeg?: string) => string,
    afterLeg?: string,
  ) {
    super(message(heldBy, afterLeg))
    this.heldBy = heldBy
  }
}

type HeldStoredLeaseResult<T> =
  | { ran: true; value: T }
  | {
      ran: false
      heldBy: string | null
      error: StoredLeaseLostError
      value?: T
    }

/** Run work under an already-acquired stored lease, renewing and guarding it. */
export async function holdStoredLease<T>(options: {
  key: string
  holder: string
  durationMs: number
  renewEveryMs: number
  trackSince?: boolean
  work: (guard: StoredLeaseGuard) => Promise<T>
  lostMessage: (heldBy: string | null, afterLeg?: string) => string
}): Promise<HeldStoredLeaseResult<T>> {
  let lostBy: string | null | undefined
  const markLost = () => {
    if (lostBy === undefined) lostBy = storedLeaseHolder(options.key)
  }
  const guard: StoredLeaseGuard = {
    assertHeld(afterLeg) {
      if (lostBy === undefined && storedLeaseHolder(options.key) !== options.holder) markLost()
      if (lostBy !== undefined)
        throw new StoredLeaseLostError(lostBy, options.lostMessage, afterLeg)
    },
  }
  const renewal = setInterval(() => {
    if (
      lostBy === undefined &&
      !acquireStoredLease(options.key, options.holder, options.durationMs, options.trackSince)
    )
      markLost()
  }, options.renewEveryMs)
  try {
    const value = await options.work(guard)
    try {
      guard.assertHeld()
      return { ran: true, value }
    } catch (error) {
      if (error instanceof StoredLeaseLostError)
        return { ran: false, heldBy: error.heldBy, error, value }
      throw error
    }
  } catch (error) {
    if (lostBy !== undefined) {
      const refusal =
        error instanceof StoredLeaseLostError
          ? error
          : new StoredLeaseLostError(lostBy, options.lostMessage)
      return { ran: false, heldBy: lostBy, error: refusal }
    }
    throw error
  } finally {
    clearInterval(renewal)
    releaseStoredLease(options.key, options.holder)
  }
}
