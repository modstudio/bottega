import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  type AssigneeRef,
  resolveAssigneeIds,
  TrackerLookupUnverifiable,
  type TrackerSource,
  type TrackerTask,
  trackerSourceFor,
} from '../../../shared/trackers.ts'
import { db, nowIso, type Project, writeTransaction } from '../db.ts'
import type { HostedStatusEvent } from '../hosted-tasks.ts'
import { credentials, Mcp } from '../mcp.ts'
import { projects } from '../projects.ts'
import { claimTaskIdentity } from '../task-identity.ts'
import { type CollectorMirrorPass, createCollectorMirrorPass } from './collector-mirror.ts'

export type { TrackerTask } from '../../../shared/trackers.ts'

async function resolveCached(
  namespace: string,
  refs: AssigneeRef[],
  lookup: (id: string, taskKey?: string) => Promise<string | null>,
): Promise<(string | null)[]> {
  const key = `tracker.assignees.${namespace}`
  const stored = db()
    .query<{ value: string }, [string]>(`SELECT value FROM setting WHERE key = ?`)
    .get(key)
  let entries: [string, string | null][] = []
  try {
    entries = stored ? JSON.parse(stored.value) : []
  } catch {
    /* rebuild invalid cache */
  }
  const cache = new Map(entries)
  const before = cache.size
  const out = await resolveAssigneeIds(refs, cache, lookup)
  if (cache.size !== before) {
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(key, JSON.stringify([...cache])),
    )
  }
  return out
}

type TrackerRegistration =
  | { project: Project; source: TrackerSource; error?: never }
  | { project: Project; source?: never; error: string }

/** Keep invalid tracker declarations as failures instead of filtering them away. */
export function trackerRegistrations(rows: ReturnType<typeof projects>): TrackerRegistration[] {
  const registrations: TrackerRegistration[] = []
  for (const project of rows) {
    if (!project.settings.tracker) continue
    try {
      const source = trackerSourceFor(project, resolveCached)
      if (source) registrations.push({ project: project.name, source })
    } catch (cause) {
      registrations.push({
        project: project.name,
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
  return registrations
}

export type TrackerResult = {
  project: Project
  tasks: number
  changed: number
  /** Whether any tracker-owned row differed from the last successful read. */
  activity?: boolean
  skipped?: string
  error?: string
}

export function trackerLegError(results: TrackerResult[]): string | null {
  const failures = results.filter((result) => result.error)
  return failures.length
    ? failures.map((result) => `${result.project}: ${result.error}`).join('; ')
    : null
}

export async function trackerCredentials(
  project: Project,
  env: string,
  read: typeof credentials = credentials,
): Promise<
  | { project: Project; credentials: { url: string; token: string } | null }
  | { project: Project; error: string }
> {
  try {
    return { project, credentials: await read(env) }
  } catch (cause) {
    return {
      project,
      error: cause instanceof Error ? cause.message : String(cause),
    }
  }
}

export const trackerProjects = () =>
  projects()
    .filter((project) => {
      if (!project.settings.tracker) return false
      try {
        return trackerSourceFor(project) !== null
      } catch {
        // Keep malformed remote declarations scheduled so collection reports their refusal.
        return true
      }
    })
    .map((project) => project.name)

type ExistingTask = {
  external_id: string | null
  project: string
  title: string | null
  status: string | null
  status_category: string | null
  updated_at: string | null
  assignee: string | null
}

const trackerTaskLabel = (project: string, key: string) => `${project}\0${key}`

const TRACKER_LABEL_COLLISION = 'tracker label collision'

type TrackerIdentityRow = {
  record_id: string
  key: string
  source: string
  external_id: string | null
  status_category: string | null
}

function differs(t: TrackerTask, old: ExistingTask | undefined): boolean {
  if (!old) return true
  return (
    old.project !== t.project ||
    (t.externalId !== null && old.external_id !== t.externalId) ||
    old.title !== t.title ||
    old.status !== t.status ||
    old.status_category !== t.category ||
    old.assignee !== t.assignee ||
    (t.updatedAt !== null && old.updated_at !== t.updatedAt)
  )
}

function trackerIdentityRow(conn: Database, t: TrackerTask): TrackerIdentityRow | null {
  let row = t.externalId
    ? conn
        .query<TrackerIdentityRow, [string, string]>(
          'SELECT record_id,key,source,external_id,status_category FROM task WHERE project=? AND external_id=?',
        )
        .get(t.project, t.externalId)
    : null

  if (!row && t.externalId) {
    row = conn
      .query<TrackerIdentityRow, [string, string]>(
        `SELECT record_id,key,source,external_id,status_category FROM task
         WHERE project=? AND key=? AND external_id IS NULL`,
      )
      .get(t.project, t.key)
  }
  if (!row && !t.externalId) {
    row = conn
      .query<TrackerIdentityRow, [string, string]>(
        'SELECT record_id,key,source,external_id,status_category FROM task WHERE project=? AND key=?',
      )
      .get(t.project, t.key)
  }
  return row
}

function trackerLabelAfterCollisionCheck(
  conn: Database,
  t: TrackerTask,
  row: TrackerIdentityRow,
): string {
  const collision =
    row.key === t.key
      ? null
      : conn
          .query<{ record_id: string }, [string, string, string]>(
            'SELECT record_id FROM task WHERE project=? AND key=? AND record_id<>?',
          )
          .get(t.project, t.key, row.record_id)
  if (collision) {
    console.error(
      `tracker label collision project=${t.project} external_id=${t.externalId} incoming=${t.key} held_by=${collision.record_id}; keeping ${row.key}`,
    )
    conn
      .query(
        `INSERT INTO task_identity_migration_repairs
           (table_name,row_id,task_key,old_record_id,new_record_id,old_external_id,new_external_id,reason,projects)
         VALUES ('task',?,?,?,?,?,?,?,?)
         ON CONFLICT(table_name,row_id,reason) DO UPDATE SET
           task_key=excluded.task_key,old_record_id=excluded.old_record_id,
           new_record_id=excluded.new_record_id,old_external_id=excluded.old_external_id,
           new_external_id=excluded.new_external_id,projects=excluded.projects`,
      )
      .run(
        row.record_id,
        t.key,
        row.record_id,
        collision.record_id,
        row.external_id,
        t.externalId,
        TRACKER_LABEL_COLLISION,
        t.project,
      )
    return row.key
  }
  conn
    .query(
      `DELETE FROM task_identity_migration_repairs
       WHERE table_name='task' AND row_id=? AND reason=?`,
    )
    .run(row.record_id, TRACKER_LABEL_COLLISION)
  return t.key
}

function updateTrackerTask(conn: Database, t: TrackerTask, row: TrackerIdentityRow, at: string) {
  conn
    .query(
      `UPDATE task SET external_id=COALESCE(?,external_id), key=?, title=?, status=?,
         status_category=?, updated_at=COALESCE(?,updated_at), assignee=?, closed_at=?,
         source='mcp', last_seen=? WHERE record_id=?`,
    )
    .run(
      t.externalId,
      trackerLabelAfterCollisionCheck(conn, t, row),
      t.title,
      t.status,
      t.category,
      t.updatedAt,
      t.assignee,
      t.category === 'done' ? at : null,
      at,
      row.record_id,
    )
}

function insertTrackerTask(conn: Database, t: TrackerTask, at: string) {
  conn
    .query(
      `INSERT INTO task (record_id, external_id, key, project, title, status, status_category,
        updated_at, assignee, closed_at, source, first_seen, last_seen)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'mcp', ?, ?)`,
    )
    .run(
      newRecordId(),
      t.externalId,
      t.key,
      t.project,
      t.title,
      t.status,
      t.category,
      t.updatedAt,
      t.assignee,
      t.category === 'done' ? at : null,
      at,
      at,
    )
}

function refreshTrackerClaim(conn: Database, t: TrackerTask, at: string) {
  const resolved = t.externalId
    ? conn
        .query<{ key: string; external_id: string }, [string, string]>(
          'SELECT key,external_id FROM task WHERE project=? AND external_id=?',
        )
        .get(t.project, t.externalId)
    : conn
        .query<{ key: string; external_id: string | null }, [string, string]>(
          'SELECT key,external_id FROM task WHERE project=? AND key=?',
        )
        .get(t.project, t.key)
  if (resolved?.external_id) {
    claimTaskIdentity(conn, {
      project: t.project,
      externalId: resolved.external_id,
      key: resolved.key,
      at,
    })
  }
}

/** Write the tracker-owned fields without ever replacing a locally-owned task. */
function upsertTrackerTaskOn(conn: Database, t: TrackerTask, at: string) {
  const row = trackerIdentityRow(conn, t)
  if (row?.source === 'local') return
  if (row) updateTrackerTask(conn, t, row, at)
  else insertTrackerTask(conn, t, at)
  refreshTrackerClaim(conn, t, at)
}

export function upsertTrackerTask(t: TrackerTask, at = nowIso()) {
  writeTransaction((conn) => upsertTrackerTaskOn(conn, t, at))
}

export type TrackerTaskObservation = {
  at: string
  taskRecordId: string | null
  taskKey: string
  event: {
    recordId: string
    fromCategory: string
    toCategory: string
  } | null
}

const PENDING_TRACKER_STATUS_EVENTS_SETTING = 'tracker.status-events.pending-mirror'
export const PENDING_TRACKER_STATUS_EVENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000

export type PendingTrackerStatusEvent = {
  eventRecordId: string
  taskRecordId: string
  project: string
  key: string
  fromCategory: string
  toCategory: string
  at: string
}

function readPendingTrackerStatusEventsOn(conn: Database): PendingTrackerStatusEvent[] {
  const row = conn
    .query<{ value: string }, [string]>('SELECT value FROM setting WHERE key=?')
    .get(PENDING_TRACKER_STATUS_EVENTS_SETTING)
  if (!row) return []
  try {
    const parsed = JSON.parse(row.value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writePendingTrackerStatusEventsOn(conn: Database, entries: PendingTrackerStatusEvent[]) {
  conn
    .query(
      `INSERT INTO setting (key,value) VALUES (?,?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
    )
    .run(PENDING_TRACKER_STATUS_EVENTS_SETTING, JSON.stringify(entries))
}

export function pendingTrackerStatusEvents(): PendingTrackerStatusEvent[] {
  return readPendingTrackerStatusEventsOn(db())
}

/** Observe one tracker row and its category transition in the same transaction. */
function observeTrackerTaskOn(
  conn: Database,
  task: TrackerTask,
  at: string,
  pendingMirror = false,
): TrackerTaskObservation {
  const stored = trackerIdentityRow(conn, task)
  const was = stored?.status_category ?? null
  const recordsTransition =
    stored !== null &&
    stored.source !== 'local' &&
    stored.status_category !== null &&
    stored.status_category !== task.category

  upsertTrackerTaskOn(conn, task, at)
  const observed = trackerIdentityRow(conn, task)
  const taskRecordId = observed?.source === 'local' ? null : (observed?.record_id ?? null)
  const taskKey = observed?.key ?? task.key
  if (!recordsTransition) return { at, taskRecordId, taskKey, event: null }

  const recordId = newRecordId()
  const inserted = conn
    .query(
      `INSERT OR IGNORE INTO task_status_event
       (record_id, task_key, task_record_id, at, from_status, to_status)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(recordId, task.key, taskRecordId!, at, was, task.category)
  const event =
    inserted.changes > 0 ? { recordId, fromCategory: was!, toCategory: task.category } : null
  if (event && pendingMirror) {
    const pending = readPendingTrackerStatusEventsOn(conn)
    const appended = {
      eventRecordId: event.recordId,
      taskRecordId: taskRecordId!,
      project: task.project,
      key: taskKey,
      fromCategory: event.fromCategory,
      toCategory: event.toCategory,
      at,
    }
    writePendingTrackerStatusEventsOn(conn, [
      ...new Map([...pending, appended].map((entry) => [entry.eventRecordId, entry])).values(),
    ])
  }
  return {
    at,
    taskRecordId,
    taskKey,
    event,
  }
}

export function observeTrackerTask(
  task: TrackerTask,
  at = nowIso(),
  pendingMirror = false,
): TrackerTaskObservation {
  return writeTransaction((conn) => observeTrackerTaskOn(conn, task, at, pendingMirror))
}

function trackerTaskMirrorRow(
  task: TrackerTask,
  taskRecordId: string,
  taskKey: string,
  at: string,
) {
  return {
    record_id: taskRecordId,
    key: taskKey,
    project: task.project,
    title: task.title,
    status: task.status,
    status_category: task.category,
    parent_key: null,
    body: null,
    assignee: task.assignee,
    opened_at: task.updatedAt ?? at,
    closed_at: task.category === 'done' ? at : null,
    source: 'mcp' as const,
    first_seen: at,
    last_seen: at,
    updated_at: task.updatedAt ?? at,
  }
}

function trackerStatusEventMirrorRow(
  task: Pick<TrackerTask, 'project' | 'key'>,
  event: NonNullable<TrackerTaskObservation['event']>,
  taskRecordId: string,
  at: string,
): HostedStatusEvent {
  return {
    id: event.recordId,
    legacy_local_id: null,
    task_key: task.key,
    task_id: taskRecordId,
    project_name: task.project,
    at,
    from_status: event.fromCategory,
    to_status: event.toCategory,
    created_at: at,
    updated_at: at,
    deleted_at: null,
  }
}

async function mirrorTrackerSnapshot(
  mirror: CollectorMirrorPass,
  observations: TrackerCacheObservation[],
): Promise<Error | null> {
  const mirroredTasks = observations.flatMap(({ task, observation }) =>
    observation.taskRecordId === null
      ? []
      : [trackerTaskMirrorRow(task, observation.taskRecordId, observation.taskKey, observation.at)],
  )
  try {
    for (let index = 0; index < mirroredTasks.length; index += 500) {
      const result = await mirror.mirrorTasks(mirroredTasks.slice(index, index + 500))
      if (result === 'refused')
        throw new Error(mirror.refusedReason?.() ?? 'project destination was refused')
    }
    return null
  } catch (error) {
    return error as Error
  }
}

function pendingStatusEventMirrorRow(entry: PendingTrackerStatusEvent): HostedStatusEvent {
  return trackerStatusEventMirrorRow(
    { project: entry.project, key: entry.key },
    {
      recordId: entry.eventRecordId,
      fromCategory: entry.fromCategory,
      toCategory: entry.toCategory,
    },
    entry.taskRecordId,
    entry.at,
  )
}

function removePendingTrackerStatusEvents(recordIds: ReadonlySet<string>) {
  writeTransaction((conn) => {
    const remaining = readPendingTrackerStatusEventsOn(conn).filter(
      (entry) => !recordIds.has(entry.eventRecordId),
    )
    writePendingTrackerStatusEventsOn(conn, remaining)
  })
}

export async function mirrorPendingTrackerStatusEvents(
  mirror: CollectorMirrorPass,
  project: Project,
  now = Date.now(),
): Promise<Error | null> {
  const projectPending = pendingTrackerStatusEvents().filter((entry) => entry.project === project)
  const expired = projectPending.filter(
    (entry) => now - Date.parse(entry.at) > PENDING_TRACKER_STATUS_EVENT_RETENTION_MS,
  )
  if (expired.length) {
    removePendingTrackerStatusEvents(new Set(expired.map((entry) => entry.eventRecordId)))
    for (const entry of expired)
      console.error(
        `hub: tracker status event mirror dropped project=${entry.project} event=${entry.eventRecordId}: pending event exceeded retention window`,
      )
  }
  const expiredIds = new Set(expired.map((entry) => entry.eventRecordId))
  const pending = projectPending
    .filter((entry) => !expiredIds.has(entry.eventRecordId))
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at))
  if (!pending.length) return null
  try {
    for (let index = 0; index < pending.length; index += 500) {
      const slice = pending.slice(index, index + 500)
      const result = await mirror.mirrorStatusEvents(slice.map(pendingStatusEventMirrorRow))
      if (result === 'refused')
        return new Error(mirror.refusedReason?.() ?? 'project destination was refused')
      if (result !== 'mirrored') return null
      removePendingTrackerStatusEvents(new Set(slice.map((entry) => entry.eventRecordId)))
    }
    return null
  } catch (error) {
    return error as Error
  }
}

async function fetchTrackerTasks(source: TrackerSource, client: Mcp): Promise<TrackerTask[]> {
  const tasks = await source.fetch(client)
  const seen = new Set(tasks.map((task) => task.key))
  const vanished = db()
    .query<{ key: string }, [string]>(
      `SELECT key FROM task
       WHERE project = ? AND source = 'mcp'
         AND status_category IN ('open','active','review')`,
    )
    .all(source.project)
    .filter((row) => !seen.has(row.key))
  for (const { key } of vanished.slice(0, 200)) {
    try {
      const task = source.lookup ? await lookupTrackerTask(source, client, key) : null
      if (task) tasks.push(task)
    } catch {
      /* unfindable: leave it as it was rather than guess */
    }
  }
  return tasks
}

async function lookupTrackerTask(
  source: TrackerSource,
  client: Mcp,
  key: string,
): Promise<TrackerTask | null> {
  try {
    return await source.lookup!(client, key)
  } catch (cause) {
    if (cause instanceof TrackerLookupUnverifiable) return null
    throw cause
  }
}

export type TrackerCacheObservation = {
  task: TrackerTask
  observation: TrackerTaskObservation
}

export function writeTrackerCache(
  tasks: Iterable<TrackerTask>,
  at: string,
): TrackerCacheObservation[] {
  const observations: TrackerCacheObservation[] = []
  writeTransaction((conn) => {
    for (const task of tasks) {
      observations.push({ task, observation: observeTrackerTaskOn(conn, task, at, true) })
    }
  })
  return observations
}

async function backfillTrackerTasks(
  mirror: CollectorMirrorPass,
  source: TrackerSource,
  client: Mcp,
  missing: { task_key: string; project: string }[],
  local: ReadonlySet<string>,
  existing: ReadonlyMap<string, ExistingTask>,
  at: string,
): Promise<{ filled: number; activity: boolean }> {
  let filled = 0
  let activity = false
  if (!source.lookup) return { filled, activity }
  for (const { task_key } of missing.filter((row) => row.project === source.project)) {
    try {
      const task = await lookupTrackerTask(source, client, task_key)
      if (!task) continue
      upsertTrackerTask(task, at)
      filled++
      const identity = trackerTaskLabel(task.project, task.key)
      if (!local.has(identity) && differs(task, existing.get(identity))) activity = true
      const localRow = trackerIdentityRow(db(), task)!
      try {
        await mirror.mirrorTasks([trackerTaskMirrorRow(task, localRow.record_id, localRow.key, at)])
      } catch (error) {
        console.error(`hub: tracker task mirror skipped: ${(error as Error).message}`)
      }
    } catch {
      /* not findable; it stays git-derived and says so */
    }
  }
  return { filled, activity }
}

/**
 * Snapshot every reachable tracker into the task table, recording transitions.
 *
 * A status EVENT is written whenever the category differs from the one last
 * seen. That is the only way to answer "completed in the last 48 hours": a
 * tracker reports when a task last changed, never when it became done, so the
 * transition has to be observed rather than queried.
 */
export async function ingestTrackers(
  only: ReadonlySet<Project> | null = null,
): Promise<TrackerResult[]> {
  const mirror = await createCollectorMirrorPass('tracker')
  const d = db()
  const at = nowIso()
  const registrations = trackerRegistrations(projects())
  const registeredProjects = new Set(registrations.map((tracker) => tracker.project))
  const orphanedPending = pendingTrackerStatusEvents().filter(
    (entry) => !registeredProjects.has(entry.project),
  )
  if (orphanedPending.length) {
    removePendingTrackerStatusEvents(new Set(orphanedPending.map((entry) => entry.eventRecordId)))
    for (const entry of orphanedPending)
      console.error(
        `hub: tracker status event mirror dropped project=${entry.project} event=${entry.eventRecordId}: project is no longer registered`,
      )
  }
  const trackers = only
    ? registrations.filter((tracker) => only.has(tracker.project))
    : registrations

  const local = new Set(
    d
      .query<{ key: string; project: string }, []>(
        `SELECT key, project FROM task WHERE source = 'local'`,
      )
      .all()
      .map((row) => trackerTaskLabel(row.project, row.key)),
  )
  const existing = new Map(
    d
      .query<ExistingTask & { key: string }, []>(
        `SELECT key, external_id, project, title, status, status_category, updated_at, assignee
         FROM task WHERE source <> 'local'`,
      )
      .all()
      .map((row) => [trackerTaskLabel(row.project, row.key), row]),
  )

  const missing = d
    .query<{ task_key: string; project: string }, []>(
      `SELECT DISTINCT i.task_key, i.project
       FROM interval i LEFT JOIN task t ON t.key = i.task_key AND t.project = i.project
      WHERE i.task_key IS NOT NULL
        AND (t.key IS NULL OR t.source <> 'mcp')
        AND i.start_at >= datetime('now', '-30 days')`,
    )
    .all()

  // A tracker row always wins over a git-derived one: git knows a key, never a
  // title or a status.
  const results = await Promise.all(
    trackers.map(
      async (
        tracker,
      ): Promise<{
        result: TrackerResult
        filled: number
      }> => {
        if ('error' in tracker) {
          return {
            result: {
              project: tracker.project,
              tasks: 0,
              changed: 0,
              error: tracker.error,
            },
            filled: 0,
          }
        }
        const s = tracker.source
        const resolved = await trackerCredentials(s.project, s.env)
        if ('error' in resolved) {
          return {
            result: {
              project: s.project,
              tasks: 0,
              changed: 0,
              error: resolved.error,
            },
            filled: 0,
          }
        }
        const creds = resolved.credentials
        if (!creds) {
          return {
            result: {
              project: s.project,
              tasks: 0,
              changed: 0,
              skipped: `no ${s.env}_MCP_URL / _TOKEN in the environment, either env file, or hosted secrets`,
            },
            filled: 0,
          }
        }
        try {
          const m = new Mcp(creds.url, creds.token)
          try {
            await m.initialize()
            const tasks = await fetchTrackerTasks(s, m)

            // One row per key. A key can arrive twice in a pass - once from the sync
            // and once from the vanished lookup - and writing both compares the second
            // against a `before` that the first already superseded, recording a
            // transition that did not happen. Last wins: the lookup is the fresher read.
            const unique = new Map(tasks.map((t) => [t.key, t]))
            let activity = [...unique.values()].some((t) => {
              const identity = trackerTaskLabel(t.project, t.key)
              return !local.has(identity) && differs(t, existing.get(identity))
            })

            const observations = writeTrackerCache(unique.values(), at)
            const changed = observations.filter(({ observation }) => observation.event).length
            const mirrorError = await mirrorTrackerSnapshot(mirror, observations)
            const pendingMirrorError = mirrorError
              ? null
              : await mirrorPendingTrackerStatusEvents(mirror, s.project)

            // Use the connection which already proved reachable for the handful of
            // closed tasks recent work names. A failed full sync is not immediately
            // retried here: that doubled traffic precisely when a server was down.
            const backfill = await backfillTrackerTasks(mirror, s, m, missing, local, existing, at)
            activity ||= backfill.activity
            return {
              result: {
                project: s.project,
                tasks: unique.size,
                changed,
                activity,
                ...(mirrorError || pendingMirrorError
                  ? {
                      error: `hosted mirror skipped: ${(mirrorError ?? pendingMirrorError)!.message}`,
                    }
                  : {}),
              },
              filled: backfill.filled,
            }
          } finally {
            await m.close()
          }
        } catch (e) {
          // One unreachable tracker must not take the collect down: the other
          // projects' work is still worth showing.
          return {
            result: {
              project: s.project,
              tasks: 0,
              changed: 0,
              error: String((e as Error).message),
            },
            filled: 0,
          }
        }
      },
    ),
  )

  // Backfill the closed tasks the window actually touched.
  //
  // The sync deliberately mirrors only open work, so a task worked on this week
  // but closed last month has a key and nothing else. Rather than page a decade
  // of finished tasks on the chance one is needed, ask for exactly the handful
  // that recent spans name - typically tens of lookups, against the 99 pages
  // fetching everything would cost.
  const filled = results.reduce((sum, item) => sum + item.filled, 0)
  const out = results.map((item) => item.result)
  if (filled)
    out.push({
      project: 'backfill',
      tasks: filled,
      changed: 0,
      activity: true,
    })

  mirror.reportSkipped()

  if (!trackerLegError(out))
    writeTransaction((conn) =>
      conn
        .query(
          `INSERT INTO setting (key, value) VALUES ('collect.trackers.at', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        )
        .run(JSON.stringify(at)),
    )
  return out
}
