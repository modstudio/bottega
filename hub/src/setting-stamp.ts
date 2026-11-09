import { db, nowIso, writeTransaction } from './db.ts'

/** Store the current time as a JSON-encoded setting value. */
export function stampSetting(key: string): void {
  writeTransaction((conn) =>
    conn
      .query(
        `INSERT INTO setting (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(nowIso())),
  )
}

/** Read a stamped setting, accepting both JSON-encoded and legacy bare values. */
export function readSettingStamp(key: string): string | null {
  const row = db()
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key = ?')
    .get(key)
  if (!row) return null
  try {
    const value: unknown = JSON.parse(row.value)
    return typeof value === 'string' ? value : row.value
  } catch {
    return row.value
  }
}
