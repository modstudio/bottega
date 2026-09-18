import { engagedMs, human } from '../../shared/interval.ts'
import { type TaskIdentity, withHostedTenant } from './hosted-tasks.ts'
import { computeMeasures, type MeasureInterval, type MeasureStatusEvent } from './measures.ts'
import { reportDefaults } from './report-types.ts'
import {
  type BoardSourceRow,
  type CompletedRow,
  type DayIntervalRow,
  type DayRow,
  type IntervalRow,
  type ProjectionProject,
  projectBoard,
  projectFlightDone,
  projectRatioSummary,
  projectSpendGrid,
  projectTasksInWindow,
  type WindowIntervalRow,
} from './task-projections.ts'

type SqlTime = string | Date
const iso = (value: SqlTime | null) => (value == null ? null : new Date(value).toISOString())
const number = (value: string | number | bigint | null | undefined) => Number(value ?? 0)
const HOSTED_STARTED_AT = new Date().toISOString()

type ProjectInput = {
  spaceId: string
  spaceName: string
  name: string
  keyPrefixes: string[]
}
const projectsOf = (rows: ProjectInput[]): ProjectionProject[] =>
  rows.map((row) => ({
    name: row.name,
    spaceId: row.spaceId,
    spaceName: row.spaceName,
    settings: { keyPrefixes: row.keyPrefixes },
  }))

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
      SELECT i.space_id, s.name AS space_name, i.task_key, i.project_name AS project,
        i.source, i.agent, i.job,
        i.start_at, i.end_at, i.claude_tokens, i.vendor_tokens, i.vendor_cost_usd, i.open,
        t.project AS task_project, t.title AS task_title, t.status AS task_status,
        t.status_category AS task_status_category, t.source AS task_source,
        t.updated_at AS task_updated_at, t.closed_at AS task_closed_at
      FROM hub_interval i JOIN space s ON s.id=i.space_id LEFT JOIN hub_task t
        ON t.space_id=i.space_id AND t.key=i.task_key AND t.deleted_at IS NULL
      WHERE i.end_at >= ${from}::timestamptz
        AND i.start_at < ${to}::timestamptz ORDER BY i.start_at`,
    )
    const completed = rows<{
      space_id: string
      key: string
      project: string
      title: string | null
      at: SqlTime
      to_status: string
    }>(
      await tx`
      SELECT e.space_id,t.key,t.project,t.title,e.at,e.to_status FROM hub_task_status_event e
      JOIN hub_task t ON t.space_id=e.space_id AND t.key=e.task_key
      WHERE e.deleted_at IS NULL AND t.deleted_at IS NULL
        AND e.at >= ${from}::timestamptz AND e.at < ${to}::timestamptz AND e.to_status='done'
      ORDER BY e.at DESC`,
    )
    const collected = rows<{ collected_at: SqlTime }>(
      await tx`
      SELECT collected_at FROM hub_day
      ORDER BY collected_at DESC LIMIT 1`,
    )[0]
    const since = new Date(new Date(to).getTime() - 14 * 86_400_000).toISOString().slice(0, 10)
    const shipped = rows<{ total: string | number }>(
      await tx`
      SELECT COALESCE(SUM(tasks),0) total FROM hub_day
      WHERE day >= ${since}`,
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
      SELECT t.space_id,s.name AS space_name,t.key,t.project,t.title,t.assignee,t.status,
        t.status_category,t.source,t.updated_at,t.last_seen
      FROM hub_task t JOIN space s ON s.id=t.space_id WHERE t.deleted_at IS NULL`,
    )
    const live = rows<{ space_id: string; task_key: string }>(
      await tx`
      SELECT DISTINCT space_id,task_key FROM hub_interval
      WHERE open=1 AND task_key IS NOT NULL`,
    )
    const recent = rows<{ space_id: string; task_key: string }>(
      await tx`
      SELECT DISTINCT space_id,task_key FROM hub_interval
      WHERE task_key IS NOT NULL AND start_at >= ${since}::timestamptz`,
    )
    return projectBoard({
      rows: sourceRows.map((row) => ({
        ...row,
        updated_at: iso(row.updated_at),
        last_seen: iso(row.last_seen)!,
      })),
      recentKeys: recent.map((row) => `${row.space_id}\0${row.task_key}`),
      liveKeys: live.map((row) => `${row.space_id}\0${row.task_key}`),
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

export async function hostedTaskDetail(
  databaseUrl: string,
  identity: TaskIdentity,
  key: string,
  spaceId = identity.spaceId,
) {
  return withHostedTenant(databaseUrl, identity, async (tx) => {
    const task = rows<Record<string, unknown>>(
      await tx`
      SELECT t.*,s.name AS space_name FROM hub_task t JOIN space s ON s.id=t.space_id
      WHERE t.space_id=${spaceId}::uuid AND key=${key}
        AND deleted_at IS NULL`,
    )[0]
    if (!task) return null
    const comments = rows<Record<string, unknown>>(
      await tx`
      SELECT id,body,created_at FROM hub_task_comment WHERE space_id=${spaceId}::uuid
        AND task_key=${key} AND deleted_at IS NULL ORDER BY created_at,id`,
    )
    const documents = rows<Record<string, unknown>>(
      await tx`
      SELECT id,role,title,body,version,created_at,updated_at FROM hub_task_document
      WHERE space_id=${spaceId}::uuid AND task_key=${key} AND deleted_at IS NULL
      ORDER BY created_at,id`,
    )
    const statusHistory = rows<Record<string, unknown>>(
      await tx`
      SELECT id,at,from_status,to_status FROM hub_task_status_event
      WHERE space_id=${spaceId}::uuid AND task_key=${key} AND deleted_at IS NULL
      ORDER BY at DESC,id`,
    )
    const intervals = rows<RawInterval & { user_id: string | null }>(
      await tx`
      SELECT task_key,project_name AS project,source,agent,job,start_at,end_at,claude_tokens,
        vendor_tokens,vendor_cost_usd,open,user_id FROM hub_interval
      WHERE space_id=${spaceId}::uuid AND task_key=${key} ORDER BY start_at DESC`,
    )
    const timeFields = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row).map(([name, value]) => [
          name,
          name.endsWith('_at') && value ? iso(value as SqlTime) : value,
        ]),
      )
    const shapedTask = timeFields(task)
    const shapedIntervals = intervals.map(interval)
    const firstRecorded = intervals.reduce<string | null>((first, row) => {
      const value = iso(row.start_at)!
      return first === null || value < first ? value : first
    }, null)
    const from = firstRecorded ?? String(shapedTask.first_seen)
    const closedAt = shapedTask.closed_at ? new Date(String(shapedTask.closed_at)).getTime() : null
    const to = new Date(closedAt === null ? Date.now() : closedAt + 1).toISOString()
    const measureIntervals: MeasureInterval[] = intervals.map((row) => ({
      source: row.source,
      startAt: iso(row.start_at)!,
      endAt: iso(row.end_at)!,
      open: number(row.open),
      userId: row.user_id,
      taskKey: key,
      project: String(shapedTask.project),
      vendorTokens: number(row.vendor_tokens),
      vendorCostUsd: row.vendor_cost_usd == null ? null : Number(row.vendor_cost_usd),
    }))
    const measureEvents: MeasureStatusEvent[] =
      closedAt === null
        ? []
        : statusHistory.map((row) => ({
            taskKey: key,
            project: String(shapedTask.project),
            at: iso(row.at as SqlTime)!,
            toStatus: String(row.to_status),
          }))
    return {
      task: shapedTask,
      comments: comments.map(timeFields),
      documents: documents.map(timeFields),
      statusHistory: statusHistory.map(timeFields),
      intervals: shapedIntervals,
      measures: computeMeasures(
        { intervals: measureIntervals, events: measureEvents },
        { from, to },
        { kind: 'space' },
      ),
      measureCoverage: { hasRecordedTime: intervals.length > 0, from, to },
    }
  })
}

export async function hostedNotes(
  databaseUrl: string,
  identity: TaskIdentity,
  input: { project?: string; stale: boolean },
) {
  return withHostedTenant(databaseUrl, identity, async (tx) => {
    type HostedNoteView = {
      space_id: string
      space_name: string
      number: string | number
      project: string
      text: string
      area: string | null
      anchors: string
      sightings: string | number
      created_at: SqlTime
      last_seen_at: SqlTime
      stale_at: SqlTime | null
      stale_reason: string | null
      promoted_task: string | null
    }
    const noteRows = rows<HostedNoteView>(
      await tx`SELECT n.id,n.space_id,s.name AS space_name,n.number,n.project,n.text,n.area,
        n.anchors,n.sightings,n.created_at,n.last_seen_at,n.stale_at,n.stale_reason,n.promoted_task
        FROM hub_note n JOIN space s ON s.id=n.space_id
        WHERE n.deleted_at IS NULL
          AND (${input.project ?? null}::text IS NULL OR project=${input.project ?? null})
          AND (${input.stale}::boolean = (stale_at IS NOT NULL))
        ORDER BY last_seen_at DESC,number DESC`,
    )
    const acknowledgements = rows<{
      space_id: string
      note_id: string | number
      session_id: string
      acknowledged_at: SqlTime
      sightings: string | number
    }>(
      await tx`SELECT a.space_id,n.number AS note_id,a.session_id,a.acknowledged_at,a.sightings FROM hub_note_acknowledgement a
        JOIN hub_note n ON n.space_id=a.space_id AND n.id=a.note_id AND n.deleted_at IS NULL
        WHERE a.deleted_at IS NULL
        ORDER BY a.acknowledged_at DESC`,
    )
    return {
      notes: noteRows.map((row) => ({
        id: number(row.number),
        space_id: row.space_id,
        space_name: row.space_name,
        project: row.project,
        text: row.text,
        area: row.area,
        anchors: JSON.parse(row.anchors) as {
          cwd: string
          files: { path: string; line: number }[]
        }[],
        sightings: number(row.sightings),
        created_at: iso(row.created_at)!,
        last_seen_at: iso(row.last_seen_at)!,
        stale_at: iso(row.stale_at),
        stale_reason: row.stale_reason,
        promoted_task: row.promoted_task,
      })),
      acknowledgements: acknowledgements.map((row) => ({
        space_id: row.space_id,
        note_id: number(row.note_id),
        session_id: row.session_id,
        acknowledged_at: iso(row.acknowledged_at)!,
        sightings: number(row.sightings),
      })),
    }
  })
}

async function hostedCostFacts(databaseUrl: string, identity: TaskIdentity, windowDays: number) {
  const now = Date.now()
  const since = new Date(now - windowDays * 86_400_000).toISOString().slice(0, 10)
  return withHostedTenant(databaseUrl, identity, async (tx) => {
    const dayRows = rows<Record<string, unknown>>(
      await tx`SELECT day,claude_tokens,tasks,commits,files,lines_product,lines_test,lines_docs,
        lines_config,lines_generated FROM hub_day WHERE space_id=${identity.spaceId}::uuid
        AND day >= ${since} ORDER BY day`,
    ).map(
      (row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            key === 'day' ? value : number(value as string | number),
          ]),
        ) as DayRow,
    )
    const intervals = rows<{ start_at: SqlTime; end_at: SqlTime; open: string | number }>(
      await tx`SELECT start_at,end_at,open FROM hub_interval WHERE space_id=${identity.spaceId}::uuid
        AND end_at >= ${`${since}T00:00:00.000Z`}::timestamptz ORDER BY start_at`,
    ).map(
      (row): DayIntervalRow => ({
        start_at: iso(row.start_at)!,
        end_at: iso(row.end_at)!,
        open: number(row.open),
      }),
    )
    return { now, since, dayRows, intervals }
  })
}

export async function hostedRatio(databaseUrl: string, identity: TaskIdentity, windowDays = 14) {
  const facts = await hostedCostFacts(databaseUrl, identity, windowDays)
  return projectRatioSummary(facts.dayRows, facts.intervals, facts.now)
}

export async function hostedSpend(databaseUrl: string, identity: TaskIdentity, windowDays = 14) {
  const facts = await hostedCostFacts(databaseUrl, identity, windowDays)
  const summary = projectRatioSummary(facts.dayRows, facts.intervals, facts.now)
  const from =
    summary.days.find((day) => !day.excluded)?.day ?? new Date(facts.now).toISOString().slice(0, 10)
  const vendors = await withHostedTenant(databaseUrl, identity, async (tx) =>
    rows<{ agent: string; tokens: string | number; cost: string | number }>(
      await tx`SELECT agent,SUM(vendor_tokens) tokens,SUM(COALESCE(vendor_cost_usd,0)) cost
      FROM hub_interval WHERE space_id=${identity.spaceId}::uuid AND source='orch' AND agent IS NOT NULL
      AND start_at >= ${`${from}T00:00:00.000Z`}::timestamptz AND start_at < ${new Date(facts.now).toISOString()}::timestamptz
      GROUP BY agent HAVING SUM(vendor_tokens) > 0 ORDER BY SUM(vendor_tokens) DESC`,
    ).map((row) => ({ agent: row.agent, tokens: number(row.tokens), cost: number(row.cost) })),
  )
  return projectSpendGrid(summary, vendors, facts.intervals, facts.now)
}

export async function hostedSettings(
  databaseUrl: string,
  identity: TaskIdentity,
  projects: string[],
) {
  return withHostedTenant(databaseUrl, identity, async (tx) => {
    const setting = rows<{ value: Record<string, unknown> }>(
      await tx`
      SELECT value FROM hub_report_setting WHERE space_id=${identity.spaceId}::uuid`,
    )[0]
    const report = { ...reportDefaults(projects), ...(setting?.value ?? {}) }
    const sends = rows<{
      at: SqlTime
      window: string
      recipients: string
      projects: string
      items: string | number
      status: string
      error: string | null
      test: string | number
    }>(
      await tx`
      SELECT at,"window",recipients,projects,items,status,error,test FROM hub_send
      WHERE space_id=${identity.spaceId}::uuid ORDER BY at DESC LIMIT 8`,
    )
    return {
      report: { ...report, smtpPasswordRef: null },
      allProjects: projects,
      secrets: {
        smtpPassword: { configured: Boolean(report.smtpPasswordRef), resolves: null as null },
      },
      sends: sends.map((row) => ({
        ...row,
        at: iso(row.at)!,
        items: number(row.items),
        test: Boolean(number(row.test)),
      })),
    }
  })
}
