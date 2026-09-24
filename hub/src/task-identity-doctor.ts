import type { Database } from 'bun:sqlite'
import { db } from './db.ts'

export type TaskIdentityDoctor = {
  tasksWithoutRecordId: number
  trackerTasksWithoutExternalId: number
  commentsWithoutTaskRecordId: number
  documentsWithoutTaskRecordId: number
  statusEventsWithoutTaskRecordId: number
  parentsWithoutRecordId: number
  promotedNotesWithoutTaskRecordId: number
  sharedKeys: { key: string; projects: string[]; lastSeen: string }[]
}

const count = (conn: Database, sql: string) =>
  conn.query<{ count: number }, []>(sql).get()?.count ?? 0

export function taskIdentityDoctor(conn: Database = db()): TaskIdentityDoctor {
  const claims = conn
    .query<{ key: string; projects: string; last_seen: string }, []>(
      `SELECT key, group_concat(DISTINCT project) projects, MAX(last_seen) last_seen
       FROM task_identity_claim GROUP BY key HAVING COUNT(DISTINCT project) > 1
       ORDER BY key`,
    )
    .all()
  return {
    tasksWithoutRecordId: count(conn, 'SELECT COUNT(*) count FROM task WHERE record_id IS NULL'),
    trackerTasksWithoutExternalId: count(
      conn,
      "SELECT COUNT(*) count FROM task WHERE source='mcp' AND external_id IS NULL",
    ),
    commentsWithoutTaskRecordId: count(
      conn,
      'SELECT COUNT(*) count FROM task_comment WHERE task_record_id IS NULL',
    ),
    documentsWithoutTaskRecordId: count(
      conn,
      'SELECT COUNT(*) count FROM task_document WHERE task_record_id IS NULL',
    ),
    statusEventsWithoutTaskRecordId: count(
      conn,
      'SELECT COUNT(*) count FROM task_status_event WHERE task_record_id IS NULL',
    ),
    parentsWithoutRecordId: count(
      conn,
      'SELECT COUNT(*) count FROM task WHERE parent_key IS NOT NULL AND parent_record_id IS NULL',
    ),
    promotedNotesWithoutTaskRecordId: count(
      conn,
      'SELECT COUNT(*) count FROM note WHERE promoted_task IS NOT NULL AND promoted_task_record_id IS NULL',
    ),
    sharedKeys: claims.map((row) => ({
      key: row.key,
      projects: row.projects.split(',').sort(),
      lastSeen: row.last_seen,
    })),
  }
}
