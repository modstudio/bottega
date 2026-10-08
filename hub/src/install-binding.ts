import type { Database } from 'bun:sqlite'
import { db, nowIso, writeTransaction } from './db.ts'
import { type InstallBinding, NEVER_BOUND } from './hosted-write-mode.ts'

const TABLE = 'install_binding'

export function readInstallBinding(conn: Database = db()): InstallBinding {
  const row = conn
    .query<{ bound: number; active_space_id: string | null }, []>(
      `SELECT bound, active_space_id FROM ${TABLE} WHERE id = 1`,
    )
    .get()
  if (!row) return NEVER_BOUND
  return {
    bound: row.bound === 1,
    activeSpaceId: row.active_space_id,
  }
}

export function persistInstallBinding(conn: Database, activeSpaceId?: string | null): void {
  const at = nowIso()
  const current = readInstallBinding(conn)
  const spaceId = activeSpaceId ?? current.activeSpaceId
  conn
    .query(
      `INSERT INTO ${TABLE} (id, bound, active_space_id, bound_at)
       VALUES (1, 1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         bound = 1,
         active_space_id = COALESCE(excluded.active_space_id, ${TABLE}.active_space_id),
         bound_at = COALESCE(${TABLE}.bound_at, excluded.bound_at)`,
    )
    .run(spaceId, at)
}

export function rememberHostedInstall(activeSpaceId?: string | null): void {
  writeTransaction((conn) => persistInstallBinding(conn, activeSpaceId))
}
