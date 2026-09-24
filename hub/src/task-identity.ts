import type { Database } from 'bun:sqlite'
import { db } from './db.ts'

export const taskIdentityRelationships = [
  { table: 'task', keyColumn: 'parent_key', recordColumn: 'parent_record_id' },
  { table: 'task_comment', keyColumn: 'task_key', recordColumn: 'task_record_id' },
  { table: 'task_document', keyColumn: 'task_key', recordColumn: 'task_record_id' },
  { table: 'task_status_event', keyColumn: 'task_key', recordColumn: 'task_record_id' },
  { table: 'note', keyColumn: 'promoted_task', recordColumn: 'promoted_task_record_id' },
] as const

export function taskRecordIdFor(conn: Database, key: string): string | null {
  return (
    conn
      .query<{ record_id: string | null }, [string]>('SELECT record_id FROM task WHERE key=?')
      .get(key)?.record_id ?? null
  )
}

export function claimTaskIdentity(
  conn: Database,
  claim: { project: string; externalId: string; key: string; at: string },
) {
  conn
    .query(
      `INSERT INTO task_identity_claim(project,external_id,key,first_seen,last_seen)
       VALUES (?,?,?,?,?) ON CONFLICT(project,external_id) DO UPDATE SET
       key=excluded.key,last_seen=excluded.last_seen`,
    )
    .run(claim.project, claim.externalId, claim.key, claim.at, claim.at)
}

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
  const missingRelationships = taskIdentityRelationships.map((relationship) =>
    count(
      conn,
      `SELECT COUNT(*) count FROM ${relationship.table} WHERE ${relationship.keyColumn} IS NOT NULL AND ${relationship.recordColumn} IS NULL`,
    ),
  )
  return {
    tasksWithoutRecordId: count(conn, 'SELECT COUNT(*) count FROM task WHERE record_id IS NULL'),
    trackerTasksWithoutExternalId: count(
      conn,
      "SELECT COUNT(*) count FROM task WHERE source='mcp' AND external_id IS NULL",
    ),
    parentsWithoutRecordId: missingRelationships[0]!,
    commentsWithoutTaskRecordId: missingRelationships[1]!,
    documentsWithoutTaskRecordId: missingRelationships[2]!,
    statusEventsWithoutTaskRecordId: missingRelationships[3]!,
    promotedNotesWithoutTaskRecordId: missingRelationships[4]!,
    sharedKeys: claims.map((row) => ({
      key: row.key,
      projects: row.projects.split(',').sort(),
      lastSeen: row.last_seen,
    })),
  }
}

export function formatTaskIdentityDoctor(identity: TaskIdentityDoctor): string[] {
  return [
    `task identity  tasks without record id ${identity.tasksWithoutRecordId}`,
    `task identity  tracker tasks without external id ${identity.trackerTasksWithoutExternalId}`,
    `task identity  comments without task record id ${identity.commentsWithoutTaskRecordId}`,
    `task identity  documents without task record id ${identity.documentsWithoutTaskRecordId}`,
    `task identity  status events without task record id ${identity.statusEventsWithoutTaskRecordId}`,
    `task identity  parents without record id ${identity.parentsWithoutRecordId}`,
    `task identity  promoted notes without task record id ${identity.promotedNotesWithoutTaskRecordId}`,
    ...identity.sharedKeys.map(
      (collision) =>
        `task identity  shared key ${collision.key} projects=${collision.projects.join(',')} last_seen=${collision.lastSeen}`,
    ),
  ]
}
