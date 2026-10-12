import { db, writeTransaction } from './db.ts'

export function acquireStoredLease(key: string, holder: string, durationMs: number): boolean {
  const now = Date.now()
  const row = writeTransaction((conn) => {
    conn
      .query(
        `INSERT INTO setting (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value
          WHERE COALESCE(json_extract(setting.value, '$.until'), 0) <= ?
             OR json_extract(setting.value, '$.holder') = ?`,
      )
      .run(key, JSON.stringify({ holder, until: now + durationMs }), now, holder)
    return conn.query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key=?`).get(key)
  })
  try {
    return (JSON.parse(row!.value) as { holder: string }).holder === holder
  } catch {
    return false
  }
}

export function releaseStoredLease(key: string, holder: string): void {
  writeTransaction((conn) =>
    conn
      .query(`DELETE FROM setting WHERE key=? AND json_extract(value, '$.holder')=?`)
      .run(key, holder),
  )
}

export function storedLeaseHolder(key: string): string | null {
  const row = db()
    .query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key=?`)
    .get(key)
  if (!row) return null
  try {
    const lease = JSON.parse(row.value) as { holder: string; until: number }
    return lease.until > Date.now() ? lease.holder : null
  } catch {
    return null
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
      !acquireStoredLease(options.key, options.holder, options.durationMs)
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
