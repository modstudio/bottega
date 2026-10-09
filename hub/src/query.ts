import { engagedMs } from '../../shared/interval.ts'
import { newRecordId } from '../../shared/record/schema.ts'
import type { Capabilities } from '../../shared/trackers.ts'
import { db, writeTransaction } from './db.ts'
import { projects } from './projects.ts'
import { taskIdentityDecision } from './task-identity.ts'
import {
  type DayIntervalRow,
  type DayRow,
  intervalEndMs,
  projectBoard,
  projectRatioSummary,
  projectRollUpDays,
  projectSpendGrid,
  projectTasksInWindow,
  type RatioSummary,
  taskIdentity,
  type WindowIntervalRow,
} from './task-projections.ts'

export type TaskRow = ReturnType<typeof projectTasksInWindow>[number]

/** One indexed overlap scan, with task metadata only for keys in that window. */
export function intervalsInWindow(from: string, to: string): WindowIntervalRow[] {
  const conn = db()
  const rows = conn
    .query<WindowIntervalRow, [string, string]>(
      `SELECT i.task_key, i.project, i.source, i.agent, i.job, i.start_at, i.end_at, i.open, i.ref,
            i.claude_tokens, i.vendor_tokens, i.vendor_cost_usd,
            NULL AS task_record_id, NULL AS task_project, NULL AS task_title, NULL AS task_status,
            NULL AS task_status_category, NULL AS task_source,
            NULL AS task_updated_at, NULL AS task_closed_at
       FROM interval i
      WHERE i.end_at >= ? AND i.start_at < ?
      ORDER BY i.start_at`,
    )
    .all(from, to)
  return rows.map((row) => {
    if (!row.task_key) return row
    const decision = taskIdentityDecision(conn, row.task_key, row.project ?? undefined)
    if ('several' in decision) {
      throw new Error(`task ${row.task_key} is ambiguous; pass --project`)
    }
    if ('one' in decision) {
      const recordId = decision.one
      const task = conn
        .query<
          {
            project: string
            title: string | null
            status: string | null
            status_category: string | null
            source: string
            updated_at: string | null
            closed_at: string | null
          },
          [string]
        >(
          `SELECT project,title,status,status_category,source,updated_at,closed_at FROM task WHERE record_id=?`,
        )
        .get(recordId)
      if (!task) return row
      return {
        ...row,
        task_record_id: recordId,
        task_project: task.project,
        task_title: task.title,
        task_status: task.status,
        task_status_category: task.status_category,
        task_source: task.source,
        task_updated_at: task.updated_at,
        task_closed_at: task.closed_at,
      }
    }
    return row
  })
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
const endMs = (r: { end_at: string; open: number }, now = Date.now()) => intervalEndMs(r, now)

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
      {
        key: string
        task_record_id: string
        project: string
        title: string | null
        at: string
        to_status: string
      },
      [string, string]
    >(
      `SELECT t.key, e.task_record_id, t.project, t.title, e.at, e.to_status
       FROM task_status_event e JOIN task t ON t.record_id = e.task_record_id
      WHERE e.at >= ? AND e.at < ? AND e.to_status = 'done'
      ORDER BY e.at DESC`,
    )
    .all(from, to)
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
  const rows = projectRollUpDays(
    d
      .query<{ source: string; start_at: string; claude_tokens: number }, []>(
        `SELECT source,start_at,claude_tokens FROM interval WHERE source IN ('claude','codex')`,
      )
      .all(),
  )

  writeTransaction((conn) => {
    const stmt = conn.query(
      `INSERT INTO day (record_id, day, claude_tokens, messages, collected_at)
     VALUES (?,?,?,?,datetime('now'))
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
    for (const r of rows) stmt.run(newRecordId(), r.day, r.claude, r.msgs)
  })
  return rows.length
}

export type { RatioSummary } from './task-projections.ts'

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
export function ratioSummary(windowDays = 14, includeEngaged = true): RatioSummary {
  const now = Date.now()
  const since = new Date(now - windowDays * 86400_000).toISOString().slice(0, 10)
  const rows = db()
    .query<DayRow, [string]>(
      `SELECT day,claude_tokens,tasks,commits,files,lines_product,lines_test,lines_docs,lines_config,lines_generated
     FROM day WHERE day >= ? ORDER BY day`,
    )
    .all(since)
  const intervals = includeEngaged
    ? db()
        .query<DayIntervalRow, [string]>(
          `SELECT start_at,end_at,open FROM interval WHERE end_at >= ? ORDER BY start_at`,
        )
        .all(`${since}T00:00:00.000Z`)
    : []
  return projectRatioSummary(rows, intervals, now, includeEngaged)
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
  const summary = ratioSummary(windowDays)
  const days = summary.days.filter((d) => !d.excluded)
  const d = db()
  const from = days.length ? `${days[0]!.day}T00:00:00.000Z` : new Date().toISOString()
  const to = new Date().toISOString()

  const vendors = d
    .query<{ agent: string; tokens: number; cost: number }, [string, string]>(
      `SELECT agent, SUM(vendor_tokens) AS tokens, SUM(COALESCE(vendor_cost_usd,0)) AS cost
       FROM interval WHERE source = 'orch' AND agent IS NOT NULL
        AND start_at >= ? AND start_at < ?
      GROUP BY agent HAVING tokens > 0 ORDER BY tokens DESC`,
    )
    .all(from, to)

  const intervals = d
    .query<DayIntervalRow, [string, string]>(
      `SELECT start_at,end_at,open FROM interval WHERE end_at >= ? AND start_at < ? ORDER BY start_at`,
    )
    .all(from, to)
  return projectSpendGrid(summary, vendors, intervals, Date.now())
}

/** One card on the board. */
type BoardTask = {
  spaceId?: string
  spaceName?: string
  recordId?: string
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
   * `updated_at` and `last_seen` describe when the tracker or collector observed
   * a task, not when work happened. The `interval` table is the record of work
   * actually happening, and it is what "recent" means here.
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
        record_id: string | null
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
      `SELECT t.key, t.record_id, t.project, t.title, t.assignee, t.status, t.status_category, t.source,
            t.updated_at, t.last_seen
       FROM task t`,
    )
    .all()

  const intervalIdentity = (row: { task_key: string; project: string | null }) => {
    const decision = taskIdentityDecision(db(), row.task_key, row.project ?? undefined)
    if ('one' in decision) {
      return taskIdentity({
        recordId: decision.one,
        key: row.task_key,
        project: row.project,
      })
    }
    if ('several' in decision) throw new Error(`task ${row.task_key} is ambiguous; pass --project`)
    return null
  }
  const recent = db()
    .query<{ task_key: string; project: string | null }, [string]>(
      `SELECT DISTINCT task_key,project FROM interval WHERE task_key IS NOT NULL AND start_at >= ?`,
    )
    .all(since)
    .map(intervalIdentity)
    .filter((id): id is string => id !== null)

  // Who is being worked on right now, in ONE query rather than one per row.
  const live = new Set(
    db()
      .query<{ task_key: string; project: string | null }, []>(
        `SELECT DISTINCT task_key,project FROM interval
        WHERE open = 1 AND task_key IS NOT NULL`,
      )
      .all()
      .map(intervalIdentity)
      .filter((id): id is string => id !== null),
  )

  return projectBoard({ rows, recentKeys: recent, liveKeys: [...live], projects: projects(), cap })
}
