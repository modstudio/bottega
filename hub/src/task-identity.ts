import type { Database } from 'bun:sqlite'
import { db } from './db.ts'

export const taskIdentityRelationships = [
  { table: 'task', keyColumn: 'parent_key', recordColumn: 'parent_record_id' },
  { table: 'task_comment', keyColumn: 'task_key', recordColumn: 'task_record_id' },
  { table: 'task_document', keyColumn: 'task_key', recordColumn: 'task_record_id' },
  { table: 'task_status_event', keyColumn: 'task_key', recordColumn: 'task_record_id' },
  { table: 'note', keyColumn: 'promoted_task', recordColumn: 'promoted_task_record_id' },
] as const

export function taskRecordIdFor(conn: Database, key: string, project?: string): string | null {
  try {
    return resolveTask(conn, key, project)
  } catch (error) {
    if (error instanceof Error && error.message === `no task ${key.toUpperCase()}`) return null
    if (
      error instanceof Error &&
      error.message.includes("candidate exists but is not cached; stage 3's re-collection")
    )
      return null
    throw error
  }
}

export type TaskIdentityCandidate = {
  project: string
  key: string
  recordId: string | null
  cached: boolean
}

/** Resolve a human label at the edge; internal task work uses the returned UUID. */
export function resolveTask(conn: Database, key: string, scope?: string): string {
  const upper = key.toUpperCase()
  const rows = conn
    .query<
      { project: string; key: string; record_id: string | null; cached: number },
      [string, string | null, string | null, string, string | null, string | null]
    >(
      `SELECT project,key,record_id,1 cached FROM task
       WHERE key=? AND (? IS NULL OR project=?)
       UNION ALL
       SELECT c.project,c.key,t.record_id,CASE WHEN t.record_id IS NULL THEN 0 ELSE 1 END cached
       FROM task_identity_claim c
       LEFT JOIN task t ON t.project=c.project AND t.external_id=c.external_id
       WHERE c.key=? AND (? IS NULL OR c.project=?)`,
    )
    .all(upper, scope ?? null, scope ?? null, upper, scope ?? null, scope ?? null)
  const candidates = new Map<string, TaskIdentityCandidate>()
  for (const row of rows) {
    const id = `${row.project}\0${row.record_id ?? ''}`
    const existing = candidates.get(id)
    if (!existing || row.cached > Number(existing.cached)) {
      candidates.set(id, {
        project: row.project,
        key: row.key,
        recordId: row.record_id,
        cached: Boolean(row.cached),
      })
    }
  }
  const found = [...candidates.values()].sort(
    (left, right) => left.project.localeCompare(right.project) || left.key.localeCompare(right.key),
  )
  if (!found.length) throw new Error(`no task ${upper}`)
  if (found.length === 1 && found[0]!.recordId) return found[0]!.recordId
  const detail = found
    .map(
      (candidate) =>
        `${candidate.project} ${candidate.key} ${candidate.recordId ?? '(not cached)'}`,
    )
    .join('\n')
  const notCached = found.some((candidate) => !candidate.recordId)
    ? "\nA candidate exists but is not cached; stage 3's re-collection will bring it back."
    : ''
  throw new Error(`task ${upper} is ambiguous:\n${detail}\npass --project${notCached}`)
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
