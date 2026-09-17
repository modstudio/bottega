import { engagedMs, human } from '../../shared/interval.ts'
import type { TrackerProject } from '../../shared/trackers.ts'
import { type TaskIdentity, withHostedTenant } from './hosted-tasks.ts'
import {
  type BoardSourceRow,
  type CompletedRow,
  type IntervalRow,
  projectBoard,
  projectFlightDone,
  projectTasksInWindow,
  type WindowIntervalRow,
} from './task-projections.ts'

type SqlTime = string | Date
const iso = (value: SqlTime | null) => (value == null ? null : new Date(value).toISOString())
const number = (value: string | number | bigint | null | undefined) => Number(value ?? 0)
const HOSTED_STARTED_AT = new Date().toISOString()

type ProjectInput = { name: string; keyPrefixes: string[] }
const projectsOf = (rows: ProjectInput[]): TrackerProject[] =>
  rows.map((row) => ({ name: row.name, settings: { keyPrefixes: row.keyPrefixes } }))

type RawInterval = Omit<IntervalRow, 'start_at' | 'end_at'> & {
  start_at: SqlTime
  end_at: SqlTime
}
type RawWindow = Omit<
  WindowIntervalRow,
  'start_at' | 'end_at' | 'task_updated_at' | 'task_closed_at'
> & {
  start_at: SqlTime
  end_at: SqlTime
  task_updated_at: SqlTime | null
  task_closed_at: SqlTime | null
}
const interval = (row: RawInterval): IntervalRow => ({
  ...row,
  start_at: iso(row.start_at)!,
  end_at: iso(row.end_at)!,
  claude_tokens: number(row.claude_tokens),
  vendor_tokens: number(row.vendor_tokens),
  vendor_cost_usd: row.vendor_cost_usd == null ? null : Number(row.vendor_cost_usd),
  open: number(row.open),
})
const windowInterval = (row: RawWindow): WindowIntervalRow => ({
  ...interval(row),
  task_project: row.task_project,
  task_title: row.task_title,
  task_status: row.task_status,
  task_status_category: row.task_status_category,
  task_source: row.task_source,
  task_updated_at: iso(row.task_updated_at),
  task_closed_at: iso(row.task_closed_at),
})

const rows = <T>(value: unknown) => value as T[]
const bounds = (hours: 24 | 48 | 168 | 720, now: number) => ({
  from: new Date(now - hours * 3_600_000).toISOString(),
  to: new Date(now).toISOString(),
})

async function windowFacts(databaseUrl: string, identity: TaskIdentity, from: string, to: string) {
  return withHostedTenant(databaseUrl, identity, async (tx) => {
    const windowRows = rows<RawWindow>(
      await tx`
      SELECT i.task_key, i.project_name AS project, i.source, i.agent, i.job,
        i.start_at, i.end_at, i.claude_tokens, i.vendor_tokens, i.vendor_cost_usd, i.open,
        t.project AS task_project, t.title AS task_title, t.status AS task_status,
        t.status_category AS task_status_category, t.source AS task_source,
        t.updated_at AS task_updated_at, t.closed_at AS task_closed_at
      FROM hub_interval i LEFT JOIN hub_task t
        ON t.space_id=i.space_id AND t.key=i.task_key AND t.deleted_at IS NULL
      WHERE i.space_id=${identity.spaceId}::uuid AND i.end_at >= ${from}::timestamptz
        AND i.start_at < ${to}::timestamptz ORDER BY i.start_at`,
    )
    const completed = rows<{
      key: string
      project: string
      title: string | null
      at: SqlTime
      to_status: string
    }>(
      await tx`
      SELECT t.key,t.project,t.title,e.at,e.to_status FROM hub_task_status_event e
      JOIN hub_task t ON t.space_id=e.space_id AND t.key=e.task_key
      WHERE e.space_id=${identity.spaceId}::uuid AND e.deleted_at IS NULL AND t.deleted_at IS NULL
        AND e.at >= ${from}::timestamptz AND e.at < ${to}::timestamptz AND e.to_status='done'
      ORDER BY e.at DESC`,
    )
    const collected = rows<{ collected_at: SqlTime }>(
      await tx`
      SELECT collected_at FROM hub_day WHERE space_id=${identity.spaceId}::uuid
      ORDER BY collected_at DESC LIMIT 1`,
    )[0]
    const since = new Date(new Date(to).getTime() - 14 * 86_400_000).toISOString().slice(0, 10)
    const shipped = rows<{ total: string | number }>(
      await tx`
      SELECT COALESCE(SUM(tasks),0) total FROM hub_day
      WHERE space_id=${identity.spaceId}::uuid AND day >= ${since}`,
    )[0]
    return {
      intervals: windowRows.map(windowInterval),
      completed: completed.map((row): CompletedRow => ({ ...row, at: iso(row.at)! })),
      collectedAt: iso(collected?.collected_at ?? null),
      tasksShipped: number(shipped?.total),
    }
  })
}

function strip(
  intervals: WindowIntervalRow[],
  tasks: ReturnType<typeof projectTasksInWindow>,
  hours: number,
  to: string,
  collectedAt: string | null,
  tasksShipped: number,
) {
  const activeAgents = [...new Set(tasks.flatMap((task) => task.activeAgents))]
  const toMs = new Date(to).getTime()
  return {
    window: `${hours}h`,
    collectedAt,
    servingSince: HOSTED_STARTED_AT,
    collector: null,
    engaged: human(
      engagedMs(
        intervals.map((row) => ({
          start: new Date(row.start_at).getTime(),
          end: Math.min(row.open ? toMs : new Date(row.end_at).getTime(), toMs),
        })),
      ),
    ),
    activeAgents,
    tasksShipped,
    counts: {
      flight: tasks.filter(
        (task) =>
          task.key && (task.workingNow || ['active', 'review'].includes(task.statusCategory ?? '')),
      ).length,
      done: tasks.filter((task) => task.key && task.statusCategory === 'done').length,
      runs: intervals.filter(
        (row) =>
          row.source === 'orch' && row.start_at >= new Date(toMs - hours * 3_600_000).toISOString(),
      ).length,
    },
  }
}

export async function hostedFlightDone(
  databaseUrl: string,
  identity: TaskIdentity,
  input: {
    name: 'flight' | 'done'
    hours: 24 | 48 | 168 | 720
    filters: { agent: string; project: string; source: string }
    projects: ProjectInput[]
  },
) {
  const now = Date.now()
  const { from, to } = bounds(input.hours, now)
  const facts = await windowFacts(databaseUrl, identity, from, to)
  const projectRows = projectsOf(input.projects)
  const tasks = projectTasksInWindow(facts.intervals, projectRows, now)
  return {
    ...strip(facts.intervals, tasks, input.hours, to, facts.collectedAt, facts.tasksShipped),
    view: input.name,
    data: projectFlightDone({
      name: input.name,
      tasks,
      completed: facts.completed,
      intervals: facts.intervals,
      filters: input.filters,
      projects: projectRows,
      now,
    }),
  }
}

export async function hostedBoard(
  databaseUrl: string,
  identity: TaskIdentity,
  input: {
    hours: 24 | 48 | 168 | 720
    filters: { agent: string; project: string; source: string }
    projects: ProjectInput[]
  },
) {
  const now = Date.now()
  const { from, to } = bounds(input.hours, now)
  const facts = await windowFacts(databaseUrl, identity, from, to)
  const projectRows = projectsOf(input.projects)
  const tasks = projectTasksInWindow(facts.intervals, projectRows, now)
  const since = new Date(now - 14 * 86_400_000).toISOString()
  const board = await withHostedTenant(databaseUrl, identity, async (tx) => {
    const sourceRows = rows<
      Omit<BoardSourceRow, 'updated_at' | 'last_seen'> & {
        updated_at: SqlTime | null
        last_seen: SqlTime
      }
    >(
      await tx`
      SELECT t.key,t.project,t.title,t.assignee,t.status,t.status_category,t.source,t.updated_at,t.last_seen
      FROM hub_task t WHERE t.space_id=${identity.spaceId}::uuid AND t.deleted_at IS NULL`,
    )
    const live = rows<{ task_key: string }>(
      await tx`
      SELECT DISTINCT task_key FROM hub_interval WHERE space_id=${identity.spaceId}::uuid
        AND open=1 AND task_key IS NOT NULL`,
    )
    const recent = rows<{ task_key: string }>(
      await tx`
      SELECT DISTINCT task_key FROM hub_interval WHERE space_id=${identity.spaceId}::uuid
        AND task_key IS NOT NULL AND start_at >= ${since}::timestamptz`,
    )
    return projectBoard({
      rows: sourceRows.map((row) => ({
        ...row,
        updated_at: iso(row.updated_at),
        last_seen: iso(row.last_seen)!,
      })),
      recentKeys: recent.map((row) => row.task_key),
      liveKeys: live.map((row) => row.task_key),
      projects: projectRows,
      cap: 250,
    })
  })
  const sourceMatches = (card: (typeof board.cards)[number]) =>
    !input.filters.source ||
    (input.filters.source === 'hub'
      ? card.source === 'local'
      : card.source !== 'local' && card.project === input.filters.source)
  const cards = board.cards.filter(
    (card) =>
      (!input.filters.project || card.project === input.filters.project) && sourceMatches(card),
  )
  const strings = (values: (string | null | undefined)[]) =>
    [...new Set(values.filter((value): value is string => Boolean(value)))].sort()
  return {
    ...strip(facts.intervals, tasks, input.hours, to, facts.collectedAt, facts.tasksShipped),
    view: 'board' as const,
    data: {
      ...board,
      cards,
      scoped: Boolean(input.filters.project || input.filters.source),
      filters: input.filters,
      matched: cards.length,
      facets: {
        agents: [] as string[],
        projects: strings([
          ...input.projects.map((item) => item.name),
          ...Object.keys(board.totals.project),
        ]),
        sources: strings([
          'hub',
          ...board.cards.filter((card) => card.source !== 'local').map((card) => card.project),
        ]),
      },
    },
  }
}

export async function hostedTaskDetail(databaseUrl: string, identity: TaskIdentity, key: string) {
  return withHostedTenant(databaseUrl, identity, async (tx) => {
    const task = rows<Record<string, unknown>>(
      await tx`
      SELECT * FROM hub_task WHERE space_id=${identity.spaceId}::uuid AND key=${key}
        AND deleted_at IS NULL`,
    )[0]
    if (!task) return null
    const comments = rows<Record<string, unknown>>(
      await tx`
      SELECT id,body,created_at FROM hub_task_comment WHERE space_id=${identity.spaceId}::uuid
        AND task_key=${key} AND deleted_at IS NULL ORDER BY created_at,id`,
    )
    const documents = rows<Record<string, unknown>>(
      await tx`
      SELECT id,role,title,body,version,created_at,updated_at FROM hub_task_document
      WHERE space_id=${identity.spaceId}::uuid AND task_key=${key} AND deleted_at IS NULL
      ORDER BY created_at,id`,
    )
    const statusHistory = rows<Record<string, unknown>>(
      await tx`
      SELECT id,at,from_status,to_status FROM hub_task_status_event
      WHERE space_id=${identity.spaceId}::uuid AND task_key=${key} AND deleted_at IS NULL
      ORDER BY at DESC,id`,
    )
    const intervals = rows<RawInterval>(
      await tx`
      SELECT task_key,project_name AS project,source,agent,job,start_at,end_at,claude_tokens,
        vendor_tokens,vendor_cost_usd,open FROM hub_interval
      WHERE space_id=${identity.spaceId}::uuid AND task_key=${key} ORDER BY start_at DESC`,
    )
    const timeFields = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).map(([name, value]) => [
          name,
          name.endsWith('_at') && value ? iso(value as SqlTime) : value,
        ]),
      )
    return {
      task: timeFields(task),
      comments: comments.map(timeFields),
      documents: documents.map(timeFields),
      statusHistory: statusHistory.map(timeFields),
      intervals: intervals.map(interval),
    }
  })
}
