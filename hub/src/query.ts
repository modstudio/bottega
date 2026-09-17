import { engagedMs } from '../../shared/interval.ts'
import type { Capabilities } from '../../shared/trackers.ts'
import { db, writeTransaction } from './db.ts'
import { projects } from './projects.ts'
import {
  type IntervalRow,
  intervalEndMs,
  projectBoard,
  projectTasksInWindow,
  type WindowIntervalRow,
} from './task-projections.ts'

export type TaskRow = ReturnType<typeof projectTasksInWindow>[number]

/** One indexed overlap scan, with task metadata only for keys in that window. */
export function intervalsInWindow(from: string, to: string): WindowIntervalRow[] {
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
  intervalEndMs(r, now)

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
  return projectTasksInWindow(intervalsInWindow(from, to), projects(), Date.now())
}

/** Everything the global strip derives from intervals, from one overlap scan. */
export function stripWindow(from: string, to: string) {
  const rows = intervalsInWindow(from, to)
  const toMs = new Date(to).getTime()
  return {
    tasks: projectTasksInWindow(rows, projects(), Date.now()),
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
 * Wall clock represented by a report's visible work.
 *
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

  writeTransaction((conn) => {
    const stmt = conn.query(
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
    for (const r of rows) stmt.run(r.day, r.claude, r.msgs)
  })
  return rows.length
}

type DayRow = {
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
function ratioDays(days = 14, includeEngaged = true): RatioDay[] {
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
type BoardTask = {
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
      []
    >(
      `SELECT t.key, t.project, t.title, t.assignee, t.status, t.status_category, t.source,
            t.updated_at, t.last_seen
       FROM task t`,
    )
    .all()

  const recent = db()
    .query<{ task_key: string }, [string]>(
      `SELECT DISTINCT task_key FROM interval WHERE task_key IS NOT NULL AND start_at >= ?`,
    )
    .all(since)
    .map((row) => row.task_key)

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

  return projectBoard({ rows, recentKeys: recent, liveKeys: [...live], projects: projects(), cap })
}
