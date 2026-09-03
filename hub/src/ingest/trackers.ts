import { db, nowIso, type Project } from '../db.ts'
import { Mcp, credentials } from '../mcp.ts'
import {
  projects, type RegisteredProject, type StatusCategory, type TrackerSettings,
} from '../projects.ts'

export type { StatusCategory } from '../projects.ts'

/**
 * The five status categories the dashboard groups on.
 *
 * Each tracker has its own vocabulary and they do not agree. Normalising here
 * rather than at the view keeps one word per state on the page, and keeps
 * `in_review` distinct from `in_progress`, which matters: a task waiting on
 * review is not idle when an agent is reviewing it.
 */
/**
 * Open work is fetched in full; closed work is not fetched at all.
 *
 * A tracker can hold ten thousand closed tasks, and mirroring a decade of
 * finished work to render a 48-hour view is absurd. Pagination is bounded by
 * MAX_PAGES, and the smaller open statuses are fetched first because they are
 * the ones "in flight" needs.
 *
 * A closed task still needs a title when something worked on it recently, and
 * that is answered by LOOKING IT UP BY KEY afterwards rather than by paging
 * everything and hoping. An earlier cut capped every status at six pages, which
 * silently truncated `done` at exactly 600 and made real tasks render as "title
 * not known, derived from commits" - a truncated read wearing the face of a
 * missing tracker.
 */
/** Enough to hold any project's open work, with a stop so nothing spins. */
const MAX_PAGES = 40

/**
 * The raw status word wins where it is FINER than the category.
 *
 * One tracker reports `status_category: "started"` for both "In Progress" and
 * "In Review", so normalising from the category alone made `review`
 * unreachable for two of the three trackers and quietly filed every
 * awaiting-review task as active. The category is the fallback, not the
 * authority, whenever the word itself says more.
 */
function categoryOf(
  rawStatus: string, category: string, states: TrackerSettings['states'],
): StatusCategory {
  const w = rawStatus.toLowerCase()
  if (/review/.test(w)) return 'review'
  if (/blocked|on hold/.test(w)) return 'review'
  const normal = (value: string) => value.toLowerCase().replace(/[ -]+/g, '_')
  const mapped = states?.[rawStatus] ?? states?.[normal(rawStatus)]
    ?? states?.[category] ?? states?.[normal(category)]
  return mapped === 'backlog' ? 'open' : mapped ?? 'open'
}

/**
 * Tracker titles arrive HTML-escaped.
 *
 * A tracker stores "Product matching &amp; resolution overhaul". Escaping that
 * again for the page renders a literal "&amp;", so it is decoded once here -
 * at the boundary where the encoding arrives, rather than by weakening the
 * escaping on the way out.
 */
const ENTITIES: Record<string, string> = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ',
}
const decode = (s: string) =>
  s.replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)

export type TrackerTask = {
  key: string
  project: Project
  title: string
  status: string
  category: StatusCategory
  updatedAt: string | null
  assignee: string | null
}

type AssigneeRef = { id?: string | number | null; name?: string | null; taskKey?: string }

/** Resolve each new id once. A cached null is a known failed resolution, not a miss. */
export async function resolveAssigneeIds(
  refs: AssigneeRef[], cache: Map<string, string | null>,
  lookup: (id: string, taskKey?: string) => Promise<string | null>,
): Promise<(string | null)[]> {
  for (const ref of refs) {
    if (ref.id == null || ref.name?.trim()) continue
    const id = String(ref.id)
    if (!cache.has(id)) {
      try { cache.set(id, await lookup(id, ref.taskKey)) }
      catch { cache.set(id, null) }
    }
  }
  return refs.map((ref) => {
    const direct = ref.name?.trim()
    if (direct) return direct
    return ref.id == null ? null : cache.get(String(ref.id)) ?? null
  })
}

async function resolveCached(
  namespace: string, refs: AssigneeRef[],
  lookup: (id: string, taskKey?: string) => Promise<string | null>,
): Promise<(string | null)[]> {
  const key = `tracker.assignees.${namespace}`
  const stored = db().query<{ value: string }, [string]>(
    `SELECT value FROM setting WHERE key = ?`,
  ).get(key)
  let entries: [string, string | null][] = []
  try { entries = stored ? JSON.parse(stored.value) : [] } catch { /* rebuild invalid cache */ }
  const cache = new Map(entries)
  const before = cache.size
  const out = await resolveAssigneeIds(refs, cache, lookup)
  if (cache.size !== before) {
    db().query(
      `INSERT INTO setting (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, JSON.stringify([...cache]))
  }
  return out
}

type Source = {
  project: Project
  /** The name in ~/.claude/.env, e.g. STARSHIP_MCP_URL. */
  env: string
  fetch: (m: Mcp) => Promise<TrackerTask[]>
  /** One closed task by key, for work the window touched but the sync skipped. */
  lookup?: (m: Mcp, key: string) => Promise<TrackerTask | null>
}

/** Trackers that speak the workspace tool shape; only the project differs. */
function workspaceSource(
  project: Project, env: string, openStatuses: string[], states: TrackerSettings['states'],
  lookup: NonNullable<TrackerSettings['assigneeLookup']>,
): Source {
  const assignees = (m: Mcp, refs: AssigneeRef[]) => resolveCached(project, refs, async (id, taskKey) => {
    if (lookup === 'task-detail' && taskKey) {
      const detail = await m.callTool('get-task-tool', { id: taskKey }) as
        { assignee?: string | null; assignee_id?: string | number | null }
      return String(detail.assignee_id) === id ? detail.assignee?.trim() || null : null
    }
    const person = await m.callTool('person-lookup-tool', { id }) as { name?: string | null }
    return person.name?.trim() || null
  })
  return {
    project, env,
    async fetch(m) {
      const out: TrackerTask[] = []
      const refs: AssigneeRef[] = []
      for (const status of openStatuses) {
        for (let page = 1; page <= MAX_PAGES; page++) {
          const r = await m.callTool('list-tasks-tool', { status, page, per_page: 100 }) as {
            tasks?: { short_id?: string; summary?: string; status?: string
                      status_category?: string; assignee_id?: string | number | null }[]
            last_page?: number
          }
          for (const t of r.tasks ?? []) {
            if (!t.short_id) continue
            out.push({
              key: t.short_id.toUpperCase(),
              project,
              title: decode(t.summary ?? ''),
              status: t.status ?? status,
              category: categoryOf(t.status ?? '', t.status_category ?? status, states),
              updatedAt: null,
              assignee: null,
            })
            refs.push({ id: t.assignee_id, taskKey: t.short_id.toUpperCase() })
          }
          if (!r.last_page || page >= r.last_page) break
        }
      }
      const names = await assignees(m, refs)
      out.forEach((task, index) => { task.assignee = names[index] ?? null })
      return out
    },
    async lookup(m, key) {
      const r = await m.callTool('list-tasks-tool', { search: key, per_page: 5 }) as {
        tasks?: { short_id?: string; summary?: string; status?: string
                  status_category?: string; assignee_id?: string | number | null }[]
      }
      const hit = (r.tasks ?? []).find((t) => t.short_id?.toUpperCase() === key)
      if (!hit) return null
      const [assignee] = await assignees(m, [{ id: hit.assignee_id, taskKey: key }])
      return {
        key, project, title: decode(hit.summary ?? ''), status: hit.status ?? '',
        category: categoryOf(hit.status ?? '', hit.status_category ?? 'completed', states), updatedAt: null,
        assignee: assignee ?? null,
      }
    },
  }
}

/**
 * Dotted tool names (`task.list`) with a `{data:{items,nextCursor}}` envelope,
 * paged by cursor. The dot matters: some clients display it as an underscore,
 * but the server's wire name remains dotted.
 */
function cursorMcpSource(
  project: Project, env: string, openStatuses: string[], states: TrackerSettings['states'],
): Source {
  return {
    project, env,
    async fetch(m) {
      const out: TrackerTask[] = []
      for (const status of openStatuses) {
        let cursor: string | undefined
        for (let page = 0; page < MAX_PAGES; page++) {
          const r = await m.callTool('task.list', {
            status, limit: 100, ...(cursor ? { cursor } : {}),
          }) as { data?: { items?: { humanKey?: string; title?: string; status?: string
                                     updatedAt?: string; assigneeName?: string | null }[]
                          nextCursor?: string } }
          for (const t of r.data?.items ?? []) {
            if (!t.humanKey) continue
            out.push({
              key: t.humanKey.toUpperCase(),
              project,
              // Titles only. The full description can run to thousands of words
              // per task; none of it belongs in hub.
              title: decode(t.title ?? ''),
              status: t.status ?? status,
              category: categoryOf(t.status ?? '', t.status ?? status, states),
              updatedAt: t.updatedAt ?? null,
              assignee: t.assigneeName?.trim() || null,
            })
          }
          cursor = r.data?.nextCursor
          if (!cursor) break
        }
      }
      return out
    },
    async lookup(m, key) {
      const r = await m.callTool('task.getByKey', { taskKey: key }) as {
        data?: { humanKey?: string; title?: string; status?: string; updatedAt?: string
                 assigneeName?: string | null }
      }
      const t = r.data
      if (!t?.humanKey) return null
      return {
        key, project, title: decode(t.title ?? ''), status: t.status ?? '',
        category: categoryOf(t.status ?? '', t.status ?? 'done', states), updatedAt: t.updatedAt ?? null,
        assignee: t.assigneeName?.trim() || null,
      }
    },
  }
}

/**
 * Underscore tool names (`task_list`) with a bare-array reply. Some servers
 * carry the task tools only on their platform origin, so the `_MCP_URL` in the
 * environment must be the platform's URL, not a product domain's.
 */
function arrayMcpSource(
  project: Project, env: string, openStatuses: string[], states: TrackerSettings['states'],
): Source {
  return {
    project, env,
    async fetch(m) {
      const out: TrackerTask[] = []
      for (const status of openStatuses) {
        const r = await m.callTool('task_list', { status }) as
          { key?: string; title?: string; status?: string; assigneeName?: string | null }[]
        for (const t of Array.isArray(r) ? r : []) {
          if (!t.key) continue
          out.push({
            key: t.key.toUpperCase(), project, title: decode(t.title ?? ''),
            status: t.status ?? status, category: categoryOf(t.status ?? '', t.status ?? status, states),
            updatedAt: null,
            assignee: t.assigneeName?.trim() || null,
          })
        }
      }
      return out
    },
    async lookup(m, key) {
      const r = await m.callTool('task_list', { search: key }) as
        { key?: string; title?: string; status?: string; updatedAt?: string
          assigneeName?: string | null }[]
      const hit = (Array.isArray(r) ? r : []).find((t) => t.key?.toUpperCase() === key)
      if (!hit) return null
      return {
        key, project, title: decode(hit.title ?? ''), status: hit.status ?? '',
        category: categoryOf(hit.status ?? '', hit.status ?? 'done', states),
        updatedAt: hit.updatedAt ?? null,
        assignee: hit.assigneeName?.trim() || null,
      }
    },
  }
}

function sourceFor(project: RegisteredProject): Source | null {
  const tracker = project.settings.tracker
  const env = tracker?.envPrefix ?? project.settings.envPrefix
  if (!tracker || !env) return null
  const statuses = tracker.openStatuses ?? []
  if (tracker.protocol === 'workspace-mcp') {
    const lookup = tracker.assigneeLookup ?? 'person-lookup'
    return workspaceSource(project.name, env, statuses, tracker.states, lookup)
  }
  if (tracker.protocol === 'cursor-mcp') {
    return cursorMcpSource(project.name, env, statuses, tracker.states)
  }
  if (tracker.protocol === 'array-mcp') {
    return arrayMcpSource(project.name, env, statuses, tracker.states)
  }
  return null
}

const SOURCES = projects().map(sourceFor).filter((source): source is Source => source !== null)

export type TrackerResult = {
  project: Project
  tasks: number
  changed: number
  /** Whether any tracker-owned row differed from the last successful read. */
  activity?: boolean
  skipped?: string
  error?: string
}

export const trackerProjects = () => SOURCES.map((source) => source.project)

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
  return old.project !== t.project || old.title !== t.title || old.status !== t.status
    || old.status_category !== t.category
    || old.assignee !== t.assignee
    || (t.updatedAt !== null && old.updated_at !== t.updatedAt)
}

/** Write the tracker-owned fields without ever replacing a locally-owned task. */
export function upsertTrackerTask(t: TrackerTask, at = nowIso()) {
  db().query(
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
  ).run(t.key, t.project, t.title, t.status, t.category, t.updatedAt, t.assignee,
        t.category === 'done' ? at : null, at, at)
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
  const sources = only ? SOURCES.filter((source) => only.has(source.project)) : SOURCES

  // Only keys whose category was already OBSERVED count as having a previous
  // state. A git-seeded row knows a key and nothing else, so treating its null
  // category as a previous value reported 316 transitions on the first collect
  // - every task in two trackers' entire history, all "just changed".
  const before = new Map(
    d.query<{ key: string; status_category: string }, []>(
      `SELECT key, status_category FROM task WHERE status_category IS NOT NULL`,
    ).all().map((r) => [r.key, r.status_category]),
  )
  const local = new Set(
    d.query<{ key: string }, []>(`SELECT key FROM task WHERE source = 'local'`)
      .all().map((row) => row.key),
  )
  const existing = new Map(
    d.query<ExistingTask & { key: string }, []>(
      `SELECT key, project, title, status, status_category, updated_at, assignee
         FROM task WHERE source <> 'local'`,
    ).all().map((row) => [row.key, row]),
  )

  const missing = d.query<{ task_key: string; project: string }, []>(
    `SELECT DISTINCT i.task_key, i.project
       FROM interval i LEFT JOIN task t ON t.key = i.task_key
      WHERE i.task_key IS NOT NULL
        AND (t.key IS NULL OR t.source <> 'mcp')
        AND i.start_at >= datetime('now', '-30 days')`,
  ).all()

  // A tracker row always wins over a git-derived one: git knows a key, never a
  // title or a status.
  const event = d.query(
    `INSERT OR IGNORE INTO task_status_event (task_key, at, from_status, to_status)
     VALUES (?,?,?,?)`,
  )

  const results = await Promise.all(sources.map(async (s): Promise<{
    result: TrackerResult
    filled: number
  }> => {
    const creds = credentials(s.env)
    if (!creds) {
      return { result: { project: s.project, tasks: 0, changed: 0,
                         skipped: `no ${s.env}_MCP_URL / _TOKEN in ~/.claude/.env` }, filled: 0 }
    }
    try {
      const m = new Mcp(creds.url, creds.token)
      await m.initialize()
      const tasks = await s.fetch(m)

      // A task that CLOSED has left the open list, so the sync will never see
      // it again — and without this it would read as active for ever, which is
      // also how the "done" view would stay permanently empty. Anything this
      // project previously reported as open and did not return now is looked up
      // by key to find out what it became.
      const seen = new Set(tasks.map((t) => t.key))
      const vanished = d.query<{ key: string }, [string]>(
        `SELECT key FROM task
          WHERE project = ? AND source = 'mcp'
            AND status_category IN ('open','active','review')`,
      ).all(s.project).filter((r) => !seen.has(r.key))

      for (const { key } of vanished.slice(0, 200)) {
        try {
          const t = s.lookup ? await s.lookup(m, key) : null
          if (t) tasks.push(t)
        } catch { /* unfindable: leave it as it was rather than guess */ }
      }

      // One row per key. A key can arrive twice in a pass - once from the sync
      // and once from the vanished lookup - and writing both compares the second
      // against a `before` that the first already superseded, recording a
      // transition that did not happen. Last wins: the lookup is the fresher read.
      const unique = new Map(tasks.map((t) => [t.key, t]))
      let activity = [...unique.values()]
        .some((t) => !local.has(t.key) && differs(t, existing.get(t.key)))

      let changed = 0
      const write = d.transaction(() => {
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
      write()

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
          } catch { /* not findable; it stays git-derived and says so */ }
        }
      }
      return { result: { project: s.project, tasks: unique.size, changed, activity }, filled }
    } catch (e) {
      // One unreachable tracker must not take the collect down: the other
      // projects' work is still worth showing.
      return { result: { project: s.project, tasks: 0, changed: 0,
                         error: String((e as Error).message) }, filled: 0 }
    }
  }))

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
