import type { Database } from 'bun:sqlite'
import { db } from './db.ts'

const TASK_KEY_PREFIX_SOURCE = '[A-Z][A-Z0-9]*'
const TASK_KEY_PATTERN = new RegExp(`^(${TASK_KEY_PREFIX_SOURCE})-\\d+$`)
const TASK_KEY_PREFIX_PATTERN = new RegExp(`^${TASK_KEY_PREFIX_SOURCE}$`)

export function isTaskKeyPrefix(value: string): boolean {
  return TASK_KEY_PREFIX_PATTERN.test(value)
}

/** Prefixes observed in canonical task identity storage. */
export function observedTaskKeyPrefixes(conn: Database = db()): string[] {
  return conn
    .query<{ key: string }, []>(`SELECT key FROM task UNION SELECT key FROM task_identity_claim`)
    .all()
    .flatMap(({ key }) => key.toUpperCase().match(TASK_KEY_PATTERN)?.[1] ?? [])
}

export const taskIdentityRelationships = [
  { table: 'task', keyColumn: 'parent_key', recordColumn: 'parent_record_id' },
  { table: 'task_comment', keyColumn: 'task_key', recordColumn: 'task_record_id' },
  { table: 'task_document', keyColumn: 'task_key', recordColumn: 'task_record_id' },
  { table: 'task_status_event', keyColumn: 'task_key', recordColumn: 'task_record_id' },
  { table: 'note', keyColumn: 'promoted_task', recordColumn: 'promoted_task_record_id' },
] as const

type TaskIdentityCandidate = {
  project: string
  key: string
  recordId: string | null
  cached: boolean
}

export type TaskIdentityDecision =
  | { one: string }
  | { none: true }
  | { uncachedOnly: TaskIdentityCandidate[] }
  | { several: TaskIdentityCandidate[] }

function taskIdentityCandidates(conn: Database, key: string): TaskIdentityCandidate[] {
  const upper = key.toUpperCase()
  const rows = conn
    .query<
      { project: string; key: string; record_id: string | null; cached: number },
      [string, string]
    >(
      `SELECT project,key,record_id,1 cached FROM task
       WHERE key=?
       UNION ALL
       SELECT c.project,c.key,t.record_id,CASE WHEN t.record_id IS NULL THEN 0 ELSE 1 END cached
       FROM task_identity_claim c
       LEFT JOIN task t ON t.project=c.project AND t.external_id=c.external_id
       WHERE c.key=?`,
    )
    .all(upper, upper)
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
  return [...candidates.values()].sort(
    (left, right) => left.project.localeCompare(right.project) || left.key.localeCompare(right.key),
  )
}

/** Make the identity choice without coupling callers to refusal text. */
function decideTaskIdentity(
  candidates: TaskIdentityCandidate[],
  project?: string,
): TaskIdentityDecision {
  const found = project
    ? candidates.filter((candidate) => candidate.project === project)
    : candidates
  if (!found.length) return { none: true }
  if (found.length === 1 && found[0]!.recordId) return { one: found[0]!.recordId }
  if (found.every((candidate) => !candidate.recordId)) return { uncachedOnly: found }
  return { several: found }
}

export function taskIdentityDecision(
  conn: Database,
  key: string,
  project?: string,
): TaskIdentityDecision {
  return decideTaskIdentity(taskIdentityCandidates(conn, key), project)
}

function nullableRecordId(decision: TaskIdentityDecision): string | null {
  if ('one' in decision) return decision.one
  if ('none' in decision || 'uncachedOnly' in decision) return null
  throw ambiguousTaskError(decision.several)
}

export const taskRecordIdFor = (conn: Database, key: string, project?: string) =>
  nullableRecordId(taskIdentityDecision(conn, key, project))

function candidateDetail(candidates: TaskIdentityCandidate[]) {
  return candidates
    .map(
      (candidate) =>
        `${candidate.project} ${candidate.key} ${candidate.recordId ?? '(not cached)'}`,
    )
    .join('\n')
}

function ambiguousTaskError(candidates: TaskIdentityCandidate[]) {
  return new Error(
    `task ${candidates[0]!.key} is ambiguous:\n${candidateDetail(candidates)}\npass --project`,
  )
}

/** Resolve a human label at the edge; internal task work uses the returned UUID. */
export function resolveTask(conn: Database, key: string, project?: string): string {
  const upper = key.toUpperCase()
  const candidates = taskIdentityCandidates(conn, upper)
  const decision = decideTaskIdentity(candidates, project)
  if ('one' in decision) return decision.one
  if ('none' in decision) throw new Error(`no task ${upper}`)
  if ('several' in decision) throw ambiguousTaskError(decision.several)

  const detail = candidateDetail(decision.uncachedOnly)
  const cachedProjects = candidates
    .filter((candidate) => candidate.recordId)
    .map((candidate) => candidate.project)
  const collision = cachedProjects.length
    ? ` because another project's task holds the same key here; pass --project ${cachedProjects[0]} to reach the cached task`
    : ''
  const subject =
    decision.uncachedOnly.length === 1
      ? `task ${upper} exists in ${decision.uncachedOnly[0]!.project} but is not cached on this machine${collision}`
      : `tasks labeled ${upper} exist but are not cached on this machine${collision}`
  throw new Error(`${subject}. Re-collect the missing project to bring it back.\n${detail}`)
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
