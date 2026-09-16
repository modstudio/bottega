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
    db()
      .query(
        `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify([...cache]))
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

export const trackerProjects = () =>
  projects()
    .filter((project) => project.settings.tracker)
    .map((project) => project.name)

type ExistingTask = {
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
    old.title !== t.title ||
    old.status !== t.status ||
    old.status_category !== t.category ||
    old.assignee !== t.assignee ||
    (t.updatedAt !== null && old.updated_at !== t.updatedAt)
  )
}

/** Write the tracker-owned fields without ever replacing a locally-owned task. */
export function upsertTrackerTask(t: TrackerTask, at = nowIso()) {
  db()
    .query(
      `INSERT INTO task (key, project, title, status, status_category, updated_at, assignee,
                       closed_at, source, first_seen, last_seen)
     VALUES (?,?,?,?,?,?,?,?, 'mcp', ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       project=excluded.project, title=excluded.title, status=excluded.status,
       status_category=excluded.status_category,
       updated_at=COALESCE(excluded.updated_at, task.updated_at),
       assignee=excluded.assignee,
       closed_at=excluded.closed_at,
       source='mcp', last_seen=excluded.last_seen
     WHERE task.source <> 'local'`,
    )
    .run(
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
        `SELECT key, project, title, status, status_category, updated_at, assignee
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
  const event = d.query(
    `INSERT OR IGNORE INTO task_status_event (task_key, at, from_status, to_status)
     VALUES (?,?,?,?)`,
  )

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
        const creds = credentials(s.env)
        if (!creds) {
          return {
            result: {
              project: s.project,
              tasks: 0,
              changed: 0,
              skipped: `no ${s.env}_MCP_URL / _TOKEN in ~/.claude/.env`,
            },
            filled: 0,
          }
        }
        try {
          const m = new Mcp(creds.url, creds.token)
          await m.initialize()
          const tasks = await s.fetch(m)

          // A task that CLOSED has left the open list, so the sync will never see
          // it again — and without this it would read as active for ever, which is
          // also how the "done" view would stay permanently empty. Anything this
          // project reported as open but did not return is looked up by key to find
          // out what it became.
          const seen = new Set(tasks.map((t) => t.key))
          const vanished = d
            .query<{ key: string }, [string]>(
              `SELECT key FROM task
          WHERE project = ? AND source = 'mcp'
            AND status_category IN ('open','active','review')`,
            )
            .all(s.project)
            .filter((r) => !seen.has(r.key))

          for (const { key } of vanished.slice(0, 200)) {
            try {
              const t = s.lookup ? await s.lookup(m, key) : null
              if (t) tasks.push(t)
            } catch {
              /* unfindable: leave it as it was rather than guess */
            }
          }

          // One row per key. A key can arrive twice in a pass - once from the sync
          // and once from the vanished lookup - and writing both compares the second
          // against a `before` that the first already superseded, recording a
          // transition that did not happen. Last wins: the lookup is the fresher read.
          const unique = new Map(tasks.map((t) => [t.key, t]))
          let activity = [...unique.values()].some(
            (t) => !local.has(t.key) && differs(t, existing.get(t.key)),
          )

          let changed = 0
          writeTransaction(() => {
            for (const t of unique.values()) {
              const was = before.get(t.key)
              upsertTrackerTask(t, at)
              // A key whose category was never observed records no transition.
              // Otherwise the first collect reports every closed task in the
              // tracker's history as having just closed.
              if (!local.has(t.key) && was !== undefined && was !== t.category) {
                event.run(t.key, at, was, t.category)
                changed++
              }
            }
          })

          // Use the connection which already proved reachable for the handful of
          // closed tasks recent work names. A failed full sync is not immediately
          // retried here: that doubled traffic precisely when a server was down.
          let filled = 0
          if (s.lookup) {
            for (const { task_key } of missing.filter((row) => row.project === s.project)) {
              try {
                const t = await s.lookup(m, task_key)
                if (!t) continue
                upsertTrackerTask(t, at)
                filled++
                if (!local.has(t.key) && differs(t, existing.get(t.key))) activity = true
              } catch {
                /* not findable; it stays git-derived and says so */
              }
            }
          }
          return { result: { project: s.project, tasks: unique.size, changed, activity }, filled }
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

  d.query(`INSERT INTO setting (key, value) VALUES ('collect.trackers.at', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(JSON.stringify(at))
  return out
}
