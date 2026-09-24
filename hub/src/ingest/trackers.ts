import type { Database } from 'bun:sqlite'
import { newRecordId } from '../../../shared/record/schema.ts'
import {
  type AssigneeRef,
  resolveAssigneeIds,
  type TrackerSource,
  type TrackerTask,
  trackerSourceFor,
} from '../../../shared/trackers.ts'
import { db, nowIso, type Project, writeTransaction } from '../db.ts'
import { credentials, Mcp } from '../mcp.ts'
import { projects } from '../projects.ts'
import { hostedMirrorTasks } from '../task-client.ts'
import { claimTaskIdentity, taskRecordIdFor } from '../task-identity.ts'

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
    return { project, error: cause instanceof Error ? cause.message : String(cause) }
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

/** Write the tracker-owned fields without ever replacing a locally-owned task. */
function upsertTrackerTaskOn(conn: Database, t: TrackerTask, at: string) {
  const recordId = newRecordId()
  conn
    .query(
      `INSERT INTO task (record_id, external_id, key, project, title, status, status_category, updated_at, assignee,
                       closed_at, source, first_seen, last_seen)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'mcp', ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       record_id=COALESCE(task.record_id, excluded.record_id),
       external_id=COALESCE(excluded.external_id, task.external_id),
       project=excluded.project, title=excluded.title, status=excluded.status,
       status_category=excluded.status_category,
       updated_at=COALESCE(excluded.updated_at, task.updated_at),
       assignee=excluded.assignee,
       closed_at=excluded.closed_at,
       source='mcp', last_seen=excluded.last_seen
     WHERE task.source <> 'local'`,
    )
    .run(
      recordId,
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
  const effectiveExternalId = conn
    .query<{ external_id: string | null }, [string]>('SELECT external_id FROM task WHERE key=?')
    .get(t.key)?.external_id
  if (effectiveExternalId)
    claimTaskIdentity(conn, {
      project: t.project,
      externalId: effectiveExternalId,
      key: t.key,
      at,
    })
}

export function upsertTrackerTask(t: TrackerTask, at = nowIso()) {
  writeTransaction((conn) => upsertTrackerTaskOn(conn, t, at))
}

async function mirrorTrackerSnapshot(
  tasks: TrackerTask[],
  local: ReadonlySet<string>,
  before: ReadonlyMap<string, string>,
  at: string,
): Promise<Error | null> {
  const mirroredTasks = tasks
    .filter((task) => !local.has(task.key))
    .map((task) => ({
      id: newRecordId(),
      key: task.key,
      project: task.project,
      project_name: task.project,
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
      created_at: at,
      updated_at: task.updatedAt ?? at,
      deleted_at: null,
    }))
  const mirroredEvents = tasks.flatMap((task) => {
    const was = before.get(task.key)
    return !local.has(task.key) && was !== undefined && was !== task.category
      ? [
          {
            id: newRecordId(),
            legacy_local_id: null,
            task_key: task.key,
            project_name: task.project,
            at,
            from_status: was,
            to_status: task.category,
            created_at: at,
            updated_at: at,
            deleted_at: null,
          },
        ]
      : []
  })
  try {
    for (let index = 0; index < mirroredTasks.length; index += 500)
      await hostedMirrorTasks({ tasks: mirroredTasks.slice(index, index + 500) })
    for (let index = 0; index < mirroredEvents.length; index += 500)
      await hostedMirrorTasks({ tasks: [], statusEvents: mirroredEvents.slice(index, index + 500) })
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
      const task = source.lookup ? await source.lookup(client, key) : null
      if (task) tasks.push(task)
    } catch {
      /* unfindable: leave it as it was rather than guess */
    }
  }
  return tasks
}

function writeTrackerCache(
  tasks: Iterable<TrackerTask>,
  before: ReadonlyMap<string, string>,
  local: ReadonlySet<string>,
  at: string,
): number {
  let changed = 0
  writeTransaction((conn) => {
    const event = conn.query(
      `INSERT OR IGNORE INTO task_status_event
       (record_id, task_key, task_record_id, at, from_status, to_status)
       VALUES (?,?,?,?,?,?)`,
    )
    for (const task of tasks) {
      const was = before.get(task.key)
      upsertTrackerTaskOn(conn, task, at)
      if (!local.has(task.key) && was !== undefined && was !== task.category) {
        const taskRecordId = taskRecordIdFor(conn, task.key, task.project)
        event.run(newRecordId(), task.key, taskRecordId, at, was, task.category)
        changed++
      }
    }
  })
  return changed
}

async function backfillTrackerTasks(
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
      const task = await source.lookup(client, task_key)
      if (!task) continue
      await hostedMirrorTasks({
        tasks: [
          {
            id: newRecordId(),
            key: task.key,
            project: task.project,
            project_name: task.project,
            title: task.title,
            status: task.status,
            status_category: task.category,
            parent_key: null,
            body: null,
            assignee: task.assignee,
            opened_at: task.updatedAt ?? at,
            closed_at: task.category === 'done' ? at : null,
            source: 'mcp',
            first_seen: at,
            last_seen: at,
            created_at: at,
            updated_at: task.updatedAt ?? at,
            deleted_at: null,
          },
        ],
      })
      upsertTrackerTask(task, at)
      filled++
      if (!local.has(task.key) && differs(task, existing.get(task.key))) activity = true
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
  const d = db()
  const at = nowIso()
  const registrations = trackerRegistrations(projects())
  const trackers = only
    ? registrations.filter((tracker) => only.has(tracker.project))
    : registrations

  // Only keys whose category was already OBSERVED count as having a previous
  // state. A git-seeded row knows a key and nothing else, so treating its null
  // category as a previous value reported 316 transitions on the first collect
  // - every task in two trackers' entire history, all "just changed".
  const before = new Map(
    d
      .query<{ key: string; status_category: string }, []>(
        `SELECT key, status_category FROM task WHERE status_category IS NOT NULL`,
      )
      .all()
      .map((r) => [r.key, r.status_category]),
  )
  const local = new Set(
    d
      .query<{ key: string }, []>(`SELECT key FROM task WHERE source = 'local'`)
      .all()
      .map((row) => row.key),
  )
  const existing = new Map(
    d
      .query<ExistingTask & { key: string }, []>(
        `SELECT key, external_id, project, title, status, status_category, updated_at, assignee
         FROM task WHERE source <> 'local'`,
      )
      .all()
      .map((row) => [row.key, row]),
  )

  const missing = d
    .query<{ task_key: string; project: string }, []>(
      `SELECT DISTINCT i.task_key, i.project
       FROM interval i LEFT JOIN task t ON t.key = i.task_key
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
            result: { project: tracker.project, tasks: 0, changed: 0, error: tracker.error },
            filled: 0,
          }
        }
        const s = tracker.source
        const resolved = await trackerCredentials(s.project, s.env)
        if ('error' in resolved) {
          return {
            result: { project: s.project, tasks: 0, changed: 0, error: resolved.error },
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
          await m.initialize()
          const tasks = await fetchTrackerTasks(s, m)

          // One row per key. A key can arrive twice in a pass - once from the sync
          // and once from the vanished lookup - and writing both compares the second
          // against a `before` that the first already superseded, recording a
          // transition that did not happen. Last wins: the lookup is the fresher read.
          const unique = new Map(tasks.map((t) => [t.key, t]))
          let activity = [...unique.values()].some(
            (t) => !local.has(t.key) && differs(t, existing.get(t.key)),
          )

          const mirrorError = await mirrorTrackerSnapshot([...unique.values()], local, before, at)
          if (mirrorError) {
            return {
              result: {
                project: s.project,
                tasks: 0,
                changed: 0,
                error: `hosted mirror skipped: ${mirrorError.message}`,
              },
              filled: 0,
            }
          }
          const changed = writeTrackerCache(unique.values(), before, local, at)

          // Use the connection which already proved reachable for the handful of
          // closed tasks recent work names. A failed full sync is not immediately
          // retried here: that doubled traffic precisely when a server was down.
          const backfill = await backfillTrackerTasks(s, m, missing, local, existing, at)
          activity ||= backfill.activity
          return {
            result: { project: s.project, tasks: unique.size, changed, activity },
            filled: backfill.filled,
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
  if (filled) out.push({ project: 'backfill', tasks: filled, changed: 0, activity: true })

  writeTransaction((conn) =>
    conn
      .query(`INSERT INTO setting (key, value) VALUES ('collect.trackers.at', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify(at)),
  )
  return out
}
