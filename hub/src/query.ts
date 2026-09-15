import { db } from './db.ts'
import { engagedMs, union, DEFAULT_IDLE_CAP_MS, type Span } from '../../shared/interval.ts'
import { projects } from './projects.ts'
import {
  trackerCapabilities,
  type Capabilities,
  type TrackerRowSource,
} from '../../shared/trackers.ts'

export type AgentSpend = { agent: string; tokens: number; costUsd: number | null; runs: number }

export type TaskRow = {
  key: string | null
  project: string | null
  title: string | null
  status: string | null
  statusCategory: string | null
  source: string | null
  sourceProtocol: string | null
  capabilities: Capabilities | null
  /** Union of every agent's working spans. Never a sum. */
  engagedMs: number
  claudeTokens: number
  /** Per agent, deliberately not totalled — see below. */
  vendors: AgentSpend[]
  /** Distinct agents with a span still open at the window's end. */
  activeAgents: string[]
  /**
   * Something is working on this NOW.
   *
   * An open delegated run, or a span that ended within the idle cap - which is
   * the same threshold engaged time uses to decide a session is still engaged,
   * so the two cannot disagree about what "working" means.
   */
  workingNow: boolean
  updatedAt: string | null
  closedAt: string | null
  intervals: number
  /** When work on this last stopped - or now, if it has not. */
  lastAt: number
}

type IntervalRow = {
  task_key: string | null
  project: string | null
  source: string
  agent: string | null
  job: string | null
  start_at: string
  end_at: string
  claude_tokens: number
  vendor_tokens: number
  vendor_cost_usd: number | null
  open: number
}

type WindowIntervalRow = IntervalRow & {
  task_project: string | null
  task_title: string | null
  task_status: string | null
  task_status_category: string | null
  task_source: string | null
  task_updated_at: string | null
  task_closed_at: string | null
}

/** One indexed overlap scan, with task metadata only for keys in that window. */
function intervalsInWindow(from: string, to: string): WindowIntervalRow[] {
  return db()
    .query<WindowIntervalRow, [string, string]>(
      `SELECT i.task_key, i.project, i.source, i.agent, i.job, i.start_at, i.end_at, i.open,
            i.claude_tokens, i.vendor_tokens, i.vendor_cost_usd,
            t.project AS task_project, t.title AS task_title, t.status AS task_status,
            t.status_category AS task_status_category, t.source AS task_source,
            t.updated_at AS task_updated_at, t.closed_at AS task_closed_at
       FROM interval i LEFT JOIN task t ON t.key = i.task_key
      WHERE i.end_at >= ? AND i.start_at < ?
      ORDER BY i.start_at`,
    )
    .all(from, to)
}

/**
 * When a span actually ends.
 *
 * An OPEN span's stored end_at is the moment the collector last looked, not the
 * moment the work stopped, so it is extended to now. Reading the stored value
 * instead made a live run look finished a second after every collect: the
 * "agents working" count sat at zero through a seven-way review fan-out, and
 * the engaged time it contributed stopped growing.
 */
export const endMs = (r: { end_at: string; open: number }, now = Date.now()) =>
  r.open ? Math.max(now, new Date(r.end_at).getTime()) : new Date(r.end_at).getTime()

/**
 * Vendor tokens are reported per agent and never summed with each other or
 * with Claude's.
 *
 * They are not the same unit. Runs 378 and 379 did comparable work on the same
 * question and reported 452,860 (grok) and 91,996 (codex) — a 5x gap that is
 * about how each vendor counts, not about how much work happened. A single
 * merged "total tokens" column would read as a measurement and be an artefact.
 */
function foldVendors(rows: IntervalRow[]): AgentSpend[] {
  const by = new Map<string, AgentSpend>()
  for (const r of rows) {
    if (r.source !== 'orch' || !r.agent) continue
    const cur = by.get(r.agent) ?? { agent: r.agent, tokens: 0, costUsd: null, runs: 0 }
    cur.tokens += r.vendor_tokens
    cur.runs += 1
    if (r.vendor_cost_usd != null) cur.costUsd = (cur.costUsd ?? 0) + r.vendor_cost_usd
    by.set(r.agent, cur)
  }
  return [...by.values()].sort((a, b) => b.tokens - a.tokens)
}

/**
 * Every task with recorded work in `[from, to)`, plus one unattributed row per
 * project.
 *
 * The unattributed rows are not noise to be filtered. Work carrying no ticket
 * is the blind spot every denominator here shares, and this project is the
 * case in point — a day building tooling spends heavily and commits nothing a
 * task-based denominator can see. Hiding it would flatter every number above it.
 */
export function tasksInWindow(from: string, to: string): TaskRow[] {
  return foldWindow(intervalsInWindow(from, to))
}

function foldWindow(rows: WindowIntervalRow[]): TaskRow[] {
  const groups = new Map<string, WindowIntervalRow[]>()
  for (const r of rows) {
    // An unattributed row is grouped by project, so one project's untracked hours do
    // not pool with another's into one meaningless bucket.
    //
    // The NUL prefix namespaces these away from real task keys, which can never
    // contain one. It must stay the ESCAPE `\0` and never a literal NUL byte in
    // the source: written literally it makes this file `data` rather than text,
    // and grep then skips all 470 lines of it in silence - no match, no warning,
    // on the file that holds every query the dashboard runs.
    const id = r.task_key ?? `\0unattributed:${r.project ?? 'unknown'}`
    const list = groups.get(id) ?? []
    list.push(r)
    groups.set(id, list)
  }

  const out: TaskRow[] = []

  for (const [id, list] of groups) {
    const unattributed = id.startsWith('\0')
    const key = unattributed ? null : id
    const first = list[0]!

    const spans: Span[] = list.map((r) => ({
      start: new Date(r.start_at).getTime(),
      end: endMs(r),
    }))

    out.push({
      key,
      project: first.task_project ?? first.project,
      title: first.task_title,
      status: first.task_status,
      statusCategory: first.task_status_category,
      source: first.task_source ?? (key ? 'git' : null),
      sourceProtocol:
        first.task_source === 'mcp'
          ? (projects().find((project) => project.name === first.task_project)?.settings.tracker
              ?.protocol ?? null)
          : null,
      capabilities: key
        ? trackerCapabilities({
            source: (first.task_source ?? 'git') as TrackerRowSource,
            project:
              projects().find(
                (project) => project.name === (first.task_project ?? first.project),
              ) ?? null,
          })
        : null,
      engagedMs: engagedMs(spans),
      claudeTokens: list.reduce((s, r) => s + r.claude_tokens, 0),
      vendors: foldVendors(list),
      // "Currently working" means a span that has not closed yet, which is what
      // an in-flight delegated run looks like from here.
      // An agent is working now when its span is still OPEN — not when its
      // stored end happens to fall after the window's edge.
      activeAgents: [...new Set(list.filter((r) => r.agent && r.open).map((r) => r.agent!))],
      workingNow: list.some((r) => r.open || endMs(r) >= Date.now() - DEFAULT_IDLE_CAP_MS),
      updatedAt: first.task_updated_at,
      closedAt: first.task_closed_at,
      intervals: list.length,
      lastAt: Math.max(...spans.map((x) => x.end)),
    })
  }

  // MOST RECENTLY ACTIVE FIRST.
  //
  // Sorting by cumulative engaged time ranked a task worked for three hours
  // yesterday above one an agent is running on right now, which buries the only
  // row that changes while you watch - in a view whose whole premise is what is
  // moving. Recency also puts live tasks on top for free: an open span runs to
  // now, so it cannot be beaten.
  return out.sort((a, b) => b.lastAt - a.lastAt)
}

/** Everything the global strip derives from intervals, from one overlap scan. */
export function stripWindow(from: string, to: string) {
  const rows = intervalsInWindow(from, to)
  const toMs = new Date(to).getTime()
  return {
    tasks: foldWindow(rows),
    engagedMs: engagedMs(
      rows.map((row) => ({
        start: new Date(row.start_at).getTime(),
        end: Math.min(endMs(row), toMs),
      })),
    ),
    orchRuns: rows.filter((row) => row.source === 'orch' && row.start_at >= from).length,
  }
}

/** Tasks whose status became `done` inside the window. */
export function completedInWindow(from: string, to: string) {
  return db()
    .query<
      { key: string; project: string; title: string | null; at: string; to_status: string },
      [string, string]
    >(
      `SELECT t.key, t.project, t.title, e.at, e.to_status
       FROM task_status_event e JOIN task t ON t.key = e.task_key
      WHERE e.at >= ? AND e.at < ? AND e.to_status = 'done'
      ORDER BY e.at DESC`,
    )
    .all(from, to)
}

/** The raw spans behind one task, so a surprising number can be traced. */
export function intervalsOf(key: string | null, project: string | null, from: string, to: string) {
  const d = db()
  return key
    ? d
        .query<IntervalRow, [string, string, string]>(
          `SELECT task_key, project, source, agent, job, start_at, end_at, open,
                claude_tokens, vendor_tokens, vendor_cost_usd
           FROM interval WHERE task_key = ? AND end_at >= ? AND start_at < ?
          ORDER BY start_at`,
        )
        .all(key, from, to)
    : d
        .query<IntervalRow, [string | null, string, string]>(
          `SELECT task_key, project, source, agent, job, start_at, end_at, open,
                claude_tokens, vendor_tokens, vendor_cost_usd
           FROM interval WHERE task_key IS NULL AND project IS ? AND end_at >= ? AND start_at < ?
          ORDER BY start_at`,
        )
        .all(project, from, to)
}

/**
 * Engaged time across the whole estate.
 *
 * Unioned across every task at once, not summed per task: two tasks worked in
 * parallel in two worktrees occupied one stretch of wall clock, and reporting
 * their sum would claim more hours than the day contains.
 */
export function estateEngagedMs(from: string, to: string): number {
  const rows = db()
    .query<{ start_at: string; end_at: string; open: number }, [string, string]>(
      `SELECT start_at, end_at, open FROM interval WHERE end_at >= ? AND start_at < ?`,
    )
    .all(from, to)
  const toMs = new Date(to).getTime()
  return engagedMs(
    rows.map((r) => ({
      start: new Date(r.start_at).getTime(),
      // Clamped to the window: an open span runs to now, which may be past `to`.
      end: Math.min(endMs(r), toMs),
    })),
  )
}

/**
 * Engaged time for ONE project, unioned.
 *
 * Not the sum of its tasks: two tasks worked in parallel in two worktrees
 * occupied one stretch of wall clock, so adding them would give a project more
 * hours than the window holds. The same rule as the estate total, narrowed.
 */
export function projectEngagedMs(project: string, from: string, to: string): number {
  const rows = db()
    .query<{ start_at: string; end_at: string; open: number }, [string, string, string]>(
      `SELECT start_at, end_at, open FROM interval
      WHERE project = ? AND end_at >= ? AND start_at < ?`,
    )
    .all(project, from, to)
  const toMs = new Date(to).getTime()
  return engagedMs(
    rows.map((r) => ({
      start: new Date(r.start_at).getTime(),
      end: Math.min(endMs(r), toMs),
    })),
  )
}

/**
 * Wall clock occupied by a specific SET of tasks.
 *
 * `projectEngagedMs` unions everything in a project, untracked work included,
 * which made a project's engaged time exceed the task hours listed under it -
 * one project showed 12.1h of task work inside 14.0h engaged, which is impossible
 * as stated and was really "plus 2h nobody had ticketed". A report that lists
 * tasks has to measure the same tasks in both columns.
 */
export function tasksEngagedMs(keys: string[], from: string, to: string): number {
  if (!keys.length) return 0
  const rows = db()
    .query<{ start_at: string; end_at: string; open: number }, string[]>(
      `SELECT start_at, end_at, open FROM interval
      WHERE task_key IN (${keys.map(() => '?').join(',')})
        AND end_at >= ? AND start_at < ?`,
    )
    .all(...keys, from, to)
  const toMs = new Date(to).getTime()
  return engagedMs(
    rows.map((r) => ({
      start: new Date(r.start_at).getTime(),
      end: Math.min(endMs(r), toMs),
    })),
  )
}

/**
 * Wall clock represented by a report's visible work.
 *
 * This cannot reuse `tasksEngagedMs`, because a report also includes the
 * untasked bucket for each selected project, or `projectEngagedMs`, because
 * that would put task keys removed by a brief's exclusion back into ENGAGED.
 * Select both visible populations here and take one union, so overlapping
 * untasked and ticketed spans are counted only once.
 */
export function reportEngagedMs(
  keys: string[],
  projects: string[],
  from: string,
  to: string,
): number {
  const taskKeys = [...new Set(keys)]
  const untaskedProjects = [...new Set(projects)]
  if (!taskKeys.length && !untaskedProjects.length) return 0

  const clauses: string[] = []
  const params: string[] = []
  if (taskKeys.length) {
    clauses.push(`task_key IN (${taskKeys.map(() => '?').join(',')})`)
    params.push(...taskKeys)
  }
  if (untaskedProjects.length) {
    clauses.push(`(task_key IS NULL AND project IN (${untaskedProjects.map(() => '?').join(',')}))`)
    params.push(...untaskedProjects)
  }

  const rows = db()
    .query<{ start_at: string; end_at: string; open: number }, string[]>(
      `SELECT start_at, end_at, open FROM interval
      WHERE (${clauses.join(' OR ')})
        AND end_at >= ? AND start_at < ?`,
    )
    .all(...params, from, to)
  const toMs = new Date(to).getTime()
  return engagedMs(
    rows.map((r) => ({
      start: new Date(r.start_at).getTime(),
      end: Math.min(endMs(r), toMs),
    })),
  )
}

export { union }

// ---------------------------------------------------------------------------
// Cost: the ratio, and the spend axis
// ---------------------------------------------------------------------------

/**
 * Roll the interval table up into the day grain.
 *
 * Derived rather than collected separately, so the two grains cannot disagree.
 * The orchestrator kept its day totals in a table written by a second pass over
 * the same transcripts, and a reading that is computed twice is a reading that
 * will eventually differ from itself.
 *
 * A day's spend is dated by the span that carries it, so a span crossing
 * midnight charges its whole spend to the day it began. That is a rounding
 * choice, not a loss: the total across days is exact, which is what the ratio
 * needs.
 */
export function rollUpDays(): number {
  const d = db()
  const rows = d
    .query<{ day: string; claude: number; msgs: number }, []>(
      `SELECT substr(start_at, 1, 10) AS day,
            SUM(claude_tokens) AS claude,
            COUNT(*)           AS msgs
       FROM interval WHERE source IN ('claude','codex')
      GROUP BY day`,
    )
    .all()

  const stmt = d.query(
    `INSERT INTO day (day, claude_tokens, messages, collected_at)
     VALUES (?,?,?,datetime('now'))
     ON CONFLICT(day) DO UPDATE SET
       -- Only a pass that FOUND tokens may overwrite them. Transcripts are
       -- pruned and work done on another machine never had any here, so a later
       -- pass can legitimately see less than an earlier one. An unconditional
       -- overwrite is what emptied five days of the orchestrator's history,
       -- and those readings could not be rebuilt.
       claude_tokens = CASE WHEN excluded.claude_tokens > 0
                            THEN excluded.claude_tokens ELSE day.claude_tokens END,
       messages      = CASE WHEN excluded.claude_tokens > 0
                            THEN excluded.messages ELSE day.messages END,
       collected_at  = excluded.collected_at`,
  )
  const write = d.transaction(() => {
    for (const r of rows) stmt.run(r.day, r.claude, r.msgs)
  })
  write()
  return rows.length
}

export type DayRow = {
  day: string
  claude_tokens: number
  tasks: number
  commits: number
  files: number
  lines_product: number
  lines_test: number
  lines_docs: number
  lines_config: number
  lines_generated: number
}

export type RatioDay = DayRow & {
  ratio: number | null
  /** Why a day does not count, or null when it does. */
  excluded: 'today' | 'gap' | null
  engagedMs: number
}

/**
 * Claude tokens per shipped task, per day, with the days that cannot be read
 * as a ratio marked rather than dropped.
 *
 * Two kinds of day are excluded, and both are still drawn:
 *
 * - **Today.** Spend accrues in real time while commits land later, so the
 *   current day always reads inflated.
 * - **A day with tasks but almost no tokens.** That is a gap, not efficiency:
 *   work done on the other machine, whose transcripts are not here. The test is
 *   proportional to the window's own median rather than a literal zero, because
 *   a day carrying 31k tokens against a 3.2B median is missing its transcripts
 *   just as surely as one carrying none — and reading it as a ratio flatters
 *   the number by three orders of magnitude.
 */
export function ratioDays(days = 14, includeEngaged = true): RatioDay[] {
  const d = db()
  const since = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)

  const rows = d
    .query<DayRow, [string]>(
      `SELECT day, claude_tokens, tasks, commits, files,
            lines_product, lines_test, lines_docs, lines_config, lines_generated
       FROM day WHERE day >= ? ORDER BY day`,
    )
    .all(since)

  const nonZero = rows
    .map((r) => r.claude_tokens)
    .filter((t) => t > 0)
    .sort((a, b) => a - b)
  const median = nonZero.length ? nonZero[Math.floor(nonZero.length / 2)]! : 0
  const floor = median * 0.05

  return rows.map((r) => {
    const excluded: RatioDay['excluded'] =
      r.day === today ? 'today' : r.tasks > 0 && r.claude_tokens < floor ? 'gap' : null
    return {
      ...r,
      excluded,
      ratio: r.tasks > 0 ? Math.round(r.claude_tokens / r.tasks) : null,
      engagedMs: includeEngaged
        ? estateEngagedMs(`${r.day}T00:00:00.000Z`, `${r.day}T23:59:59.999Z`)
        : 0,
    }
  })
}

export type RatioSummary = {
  perTask: number | null
  tokens: number
  tasks: number
  usableDays: number
  direction: 'improving' | 'flat' | 'worsening' | 'unknown'
  changePct: number | null
  days: RatioDay[]
}

/** Fewer than this in either half and the denominator moves more than the thing measured. */
const MIN_TASKS = 5

export function ratioSummary(windowDays = 14, includeEngaged = true): RatioSummary {
  const days = ratioDays(windowDays, includeEngaged)
  const usable = days.filter((d) => !d.excluded && d.tasks > 0)
  const tokens = usable.reduce((s, d) => s + d.claude_tokens, 0)
  const tasks = usable.reduce((s, d) => s + d.tasks, 0)

  // Halves of the window, not consecutive days: tasks land in bursts, so
  // day-on-day says nothing. Each half is totalled and divided ONCE — averaging
  // daily ratios would weigh a quiet day with one task as heavily as a busy one
  // with thirty.
  const half = Math.floor(usable.length / 2)
  const earlier = usable.slice(0, half)
  const recent = usable.slice(usable.length - half)
  const sum = (xs: RatioDay[], k: 'claude_tokens' | 'tasks') => xs.reduce((s, d) => s + d[k], 0)

  let direction: RatioSummary['direction'] = 'unknown'
  let changePct: number | null = null
  if (half > 0 && sum(earlier, 'tasks') >= MIN_TASKS && sum(recent, 'tasks') >= MIN_TASKS) {
    const a = sum(earlier, 'claude_tokens') / sum(earlier, 'tasks')
    const b = sum(recent, 'claude_tokens') / sum(recent, 'tasks')
    changePct = ((b - a) / a) * 100
    // Inside the noise these bursts generate, calling a direction would be
    // reading intent into scheduling.
    direction = Math.abs(changePct) < 10 ? 'flat' : changePct < 0 ? 'improving' : 'worsening'
  }

  return {
    perTask: tasks > 0 ? Math.round(tokens / tasks) : null,
    tokens,
    tasks,
    usableDays: usable.length,
    direction,
    changePct,
    days,
  }
}

export type SpendCell = { numerator: string; denominator: string; value: number | null }

/**
 * The spend axis: every currency against every denominator.
 *
 * No denominator is trustworthy alone and the signal is whether they agree,
 * which is exactly why this is a grid rather than one headline. Each is wrong
 * in its own direction: tasks miss work carrying no ticket, lines reward
 * verbosity, commits follow habit rather than effort, and files touched says
 * nothing about depth. Engaged hour is the only one that depends on none of
 * those.
 */
export function spendGrid(windowDays = 14) {
  const days = ratioDays(windowDays).filter((d) => !d.excluded)
  const d = db()
  const from = days.length ? `${days[0]!.day}T00:00:00.000Z` : new Date().toISOString()
  const to = new Date().toISOString()

  const denominators = {
    'shipped task': days.reduce((s, x) => s + x.tasks, 0),
    commit: days.reduce((s, x) => s + x.commits, 0),
    'product line': days.reduce((s, x) => s + x.lines_product, 0),
    'file touched': days.reduce((s, x) => s + x.files, 0),
    'engaged hour': estateEngagedMs(from, to) / 3600_000,
  }

  const vendors = d
    .query<{ agent: string; tokens: number; cost: number }, [string, string]>(
      `SELECT agent, SUM(vendor_tokens) AS tokens, SUM(COALESCE(vendor_cost_usd,0)) AS cost
       FROM interval WHERE source = 'orch' AND agent IS NOT NULL
        AND start_at >= ? AND start_at < ?
      GROUP BY agent HAVING tokens > 0 ORDER BY tokens DESC`,
    )
    .all(from, to)

  const claude = days.reduce((s, x) => s + x.claude_tokens, 0)
  const cost = vendors.reduce((s, v) => s + v.cost, 0)

  // Columns are separate currencies and are never summed with one another.
  const numerators = [
    { name: 'claude', total: claude, kind: 'tokens' as const },
    ...vendors.map((v) => ({ name: v.agent, total: v.tokens, kind: 'tokens' as const })),
    { name: 'cost', total: cost, kind: 'usd' as const },
  ]

  return {
    from: from.slice(0, 10),
    days: days.length,
    numerators,
    denominators,
    lineMix: {
      generated: days.reduce((s, x) => s + x.lines_generated, 0),
      product: days.reduce((s, x) => s + x.lines_product, 0),
      test: days.reduce((s, x) => s + x.lines_test, 0),
      docs: days.reduce((s, x) => s + x.lines_docs, 0),
      config: days.reduce((s, x) => s + x.lines_config, 0),
    },
  }
}

/** One card on the board. */
export type BoardTask = {
  key: string
  project: string | null
  title: string | null
  assignee: string | null
  status: string | null
  statusCategory: string | null
  /** 'local' is ours to edit; 'mcp' is a tracker's; 'git' was inferred from commits. */
  source: string
  sourceProtocol: string | null
  capabilities: Capabilities
  updatedAt: string | null
  /** Whether an agent is working on it right now. */
  workingNow: boolean
}

/**
 * Every task in play, across every project, whoever owns it.
 *
 * NOT window-scoped, and that is the difference from `tasksInWindow`. That
 * function answers "what did work happen on recently", which is the right
 * question for a report and the wrong one for a board: a task nobody touched
 * this week is still in flight, and a board that hid it would be describing
 * activity rather than state.
 *
 * Both kinds of task appear side by side and are distinguished rather than
 * blended. A row from a project's own tracker is the tracker's to change; a
 * row this system issued is ours. Showing them together is the point — the
 * estate's work does not sort itself by which system happens to hold it — but
 * a reader has to be able to tell which they can act on here.
 *
 * A BOARD IS WORK IN PLAY, NOT A BACKLOG. Unfiltered, the estate has 853 open
 * tasks and three thousand closed inside a fortnight — a board showing those is
 * a list of everything, which is the one thing nobody can act on. So a card
 * earns its place by being active, in review, worked on right now, or recently
 * finished; a queued item appears only once something has actually happened to
 * it. The full backlog lives in each project's own tracker, which is the right
 * home for it.
 */
/** The board, and what it is a page of. */
export type Board = {
  cards: BoardTask[]
  /**
   * TRUE totals per column, from the same filter — never a count of the page.
   *
   * Keyed by DIMENSION, because the board groups by either status or project
   * and a header must carry the real total whichever way it is sliced. Counting
   * the drawn cards would understate every column the moment the set outgrows
   * one fetch, which for `done` it always does.
   */
  totals: { status: Record<string, number>; project: Record<string, number> }
  /** How many cards were asked for. */
  cap: number
}

export function boardTasks(windowDays = 14, cap = 250): Board {
  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString()

  /**
   * RECENCY COMES FROM WORK, NEVER FROM A TIMESTAMP ON THE TASK.
   *
   * `updated_at` and `last_seen` are bumped every time ingest sees a row, so
   * every task a tracker still returns looks freshly touched: filtering on them
   * returned 3,551 cards, the whole estate wearing a recency filter that
   * excluded nothing. The `interval` table is the only record of work actually
   * happening, and it is what "recent" has to mean here.
   */
  const WHERE = `WHERE t.status_category IN ('active','review')
        OR EXISTS (SELECT 1 FROM interval i
                    WHERE i.task_key = t.key AND i.start_at >= ?)
        OR (t.source = 'local'
            AND (t.status_category IS NULL
                 OR t.status_category NOT IN ('done','dropped')))`

  /**
   * TRUE TOTALS, counted with the same filter rather than by bucketing the page.
   *
   * Borrowed from a sibling project's own board, whose repository says it plainly: a
   * board buckets the rows it was given, so a column header counting them
   * reports the page rather than the filter — understating every column once
   * the set outgrows one fetch, and saying nothing at all about a column whose
   * rows all fell outside it. A surface showing part of a set has to be able to
   * say so instead of looking complete.
   */
  const countBy = (expr: string) => {
    const out: Record<string, number> = {}
    for (const r of db()
      .query<{ bucket: string; n: number }, [string]>(
        `SELECT ${expr} AS bucket, COUNT(*) AS n FROM task t ${WHERE} GROUP BY bucket`,
      )
      .all(since))
      out[r.bucket] = r.n
    return out
  }
  const totals = {
    status: countBy("COALESCE(t.status_category, 'unknown')"),
    project: countBy("COALESCE(t.project, 'elsewhere')"),
  }

  /**
   * SPEND THE BUDGET ON OPEN WORK — also borrowed from that sibling project, and the reason a capped
   * board is usable at all.
   *
   * Completed work is the bulk of any estate and it crowds out the columns
   * people actually work from. Sorted last, the page covers the live columns in
   * full and the shortfall lands where it costs least: on Done, whose header
   * still reports its true total.
   */
  const rows = db()
    .query<
      {
        key: string
        project: string | null
        title: string | null
        assignee: string | null
        status: string | null
        status_category: string | null
        source: string
        updated_at: string | null
        last_seen: string
      },
      [string, number]
    >(
      `SELECT t.key, t.project, t.title, t.assignee, t.status, t.status_category, t.source,
            t.updated_at, t.last_seen
       FROM task t ${WHERE}
      ORDER BY
        CASE t.status_category
          WHEN 'active' THEN 0 WHEN 'review' THEN 1
          WHEN 'done' THEN 3 WHEN 'dropped' THEN 4 ELSE 2 END,
        COALESCE(t.updated_at, t.last_seen) DESC
      LIMIT ?`,
    )
    .all(since, cap)

  // Who is being worked on right now, in ONE query rather than one per row.
  const live = new Set(
    db()
      .query<{ task_key: string }, []>(
        `SELECT DISTINCT task_key FROM interval
        WHERE open = 1 AND task_key IS NOT NULL`,
      )
      .all()
      .map((r) => r.task_key),
  )

  return {
    cards: rows.map((r) => ({
      key: r.key,
      project: r.project,
      title: r.title,
      assignee: r.assignee,
      status: r.status,
      statusCategory: r.status_category,
      source: r.source,
      sourceProtocol:
        r.source === 'mcp'
          ? (projects().find((project) => project.name === r.project)?.settings.tracker?.protocol ??
            null)
          : null,
      capabilities: trackerCapabilities({
        source: r.source as TrackerRowSource,
        project: projects().find((project) => project.name === r.project) ?? null,
      }),
      updatedAt: r.updated_at ?? r.last_seen,
      workingNow: live.has(r.key),
    })),
    totals,
    cap,
  }
}
