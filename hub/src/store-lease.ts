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
