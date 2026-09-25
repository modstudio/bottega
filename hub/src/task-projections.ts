import { DEFAULT_IDLE_CAP_MS, engagedMs, human, type Span } from '../../shared/interval.ts'
import {
  type Capabilities,
  type TrackerProject,
  type TrackerRowSource,
  trackerCapabilities,
} from '../../shared/trackers.ts'
import { runRef } from './run-ref.ts'

export type ProjectionProject = TrackerProject & { spaceId?: string; spaceName?: string }

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

export type DayIntervalRow = {
  start_at: string
  end_at: string
  open: number
}

export type VendorSpendRow = { agent: string; tokens: number; cost: number }
export type RollupIntervalRow = { source: string; start_at: string; claude_tokens: number }

export function projectRollUpDays(rows: RollupIntervalRow[]) {
  const grouped = new Map<string, { day: string; claude: number; msgs: number }>()
  for (const row of rows) {
    if (row.source !== 'claude' && row.source !== 'codex') continue
    const day = row.start_at.slice(0, 10)
    const current = grouped.get(day) ?? { day, claude: 0, msgs: 0 }
    current.claude += row.claude_tokens
    current.msgs += 1
    grouped.set(day, current)
  }
  return [...grouped.values()].sort((left, right) => left.day.localeCompare(right.day))
}

type RatioDay = DayRow & {
  ratio: number | null
  excluded: 'today' | 'gap' | null
  engagedMs: number
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

const MIN_RATIO_TASKS = 5

export function projectRatioSummary(
  rows: DayRow[],
  intervals: DayIntervalRow[],
  now: number,
  includeEngaged = true,
): RatioSummary {
  const today = new Date(now).toISOString().slice(0, 10)
  const nonZero = rows
    .map((row) => row.claude_tokens)
    .filter((value) => value > 0)
    .sort((a, b) => a - b)
  const floor = (nonZero.length ? nonZero[Math.floor(nonZero.length / 2)]! : 0) * 0.05
  const days = rows.map((row): RatioDay => {
    const excluded: RatioDay['excluded'] =
      row.day === today ? 'today' : row.tasks > 0 && row.claude_tokens < floor ? 'gap' : null
    const from = `${row.day}T00:00:00.000Z`
    const to = `${row.day}T23:59:59.999Z`
    return {
      ...row,
      excluded,
      ratio: row.tasks > 0 ? Math.round(row.claude_tokens / row.tasks) : null,
      engagedMs: includeEngaged
        ? engagedMs(
            intervals
              .filter((item) => item.end_at >= from && item.start_at < to)
              .map((item) => ({
                start: new Date(item.start_at).getTime(),
                end: Math.min(intervalEndMs(item, now), new Date(to).getTime()),
              })),
          )
        : 0,
    }
  })
  const usable = days.filter((day) => !day.excluded && day.tasks > 0)
  const tokens = usable.reduce((sum, day) => sum + day.claude_tokens, 0)
  const tasks = usable.reduce((sum, day) => sum + day.tasks, 0)
  const half = Math.floor(usable.length / 2)
  const earlier = usable.slice(0, half)
  const recent = usable.slice(usable.length - half)
  const sum = (items: RatioDay[], key: 'claude_tokens' | 'tasks') =>
    items.reduce((total, day) => total + day[key], 0)
  let direction: RatioSummary['direction'] = 'unknown'
  let changePct: number | null = null
  if (
    half > 0 &&
    sum(earlier, 'tasks') >= MIN_RATIO_TASKS &&
    sum(recent, 'tasks') >= MIN_RATIO_TASKS
  ) {
    const before = sum(earlier, 'claude_tokens') / sum(earlier, 'tasks')
    const after = sum(recent, 'claude_tokens') / sum(recent, 'tasks')
    changePct = ((after - before) / before) * 100
    direction = Math.abs(changePct) < 10 ? 'flat' : changePct < 0 ? 'improving' : 'worsening'
  }
  return {
    perTask: tasks ? Math.round(tokens / tasks) : null,
    tokens,
    tasks,
    usableDays: usable.length,
    direction,
    changePct,
    days,
  }
}

export function projectSpendGrid(
  summary: RatioSummary,
  vendors: VendorSpendRow[],
  intervals: DayIntervalRow[],
  now: number,
) {
  const days = summary.days.filter((day) => !day.excluded)
  const from = days.length ? `${days[0]!.day}T00:00:00.000Z` : new Date(now).toISOString()
  const denominators = {
    'shipped task': days.reduce((sum, day) => sum + day.tasks, 0),
    commit: days.reduce((sum, day) => sum + day.commits, 0),
    'product line': days.reduce((sum, day) => sum + day.lines_product, 0),
    'file touched': days.reduce((sum, day) => sum + day.files, 0),
    'engaged hour':
      engagedMs(
        intervals
          .filter((row) => row.end_at >= from && new Date(row.start_at).getTime() < now)
          .map((row) => ({
            start: new Date(row.start_at).getTime(),
            end: Math.min(intervalEndMs(row, now), now),
          })),
      ) / 3_600_000,
  }
  const cost = vendors.reduce((sum, vendor) => sum + vendor.cost, 0)
  return {
    from: from.slice(0, 10),
    days: days.length,
    numerators: [
      {
        name: 'claude',
        total: days.reduce((sum, day) => sum + day.claude_tokens, 0),
        kind: 'tokens' as const,
      },
      ...vendors.map((vendor) => ({
        name: vendor.agent,
        total: vendor.tokens,
        kind: 'tokens' as const,
      })),
      { name: 'cost', total: cost, kind: 'usd' as const },
    ],
    denominators,
    lineMix: {
      generated: days.reduce((sum, day) => sum + day.lines_generated, 0),
      product: days.reduce((sum, day) => sum + day.lines_product, 0),
      test: days.reduce((sum, day) => sum + day.lines_test, 0),
      docs: days.reduce((sum, day) => sum + day.lines_docs, 0),
      config: days.reduce((sum, day) => sum + day.lines_config, 0),
    },
  }
}

export type IntervalRow = {
  ref?: string
  space_id?: string
  space_name?: string
  task_key: string | null
  task_record_id?: string | null
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

export type WindowIntervalRow = IntervalRow & {
  task_project: string | null
  task_title: string | null
  task_status: string | null
  task_status_category: string | null
  task_source: string | null
  task_updated_at: string | null
  task_closed_at: string | null
}

type AgentSpend = { agent: string; tokens: number; costUsd: number | null; runs: number }
export type ProjectedTask = {
  spaceId?: string
  spaceName?: string
  key: string | null
  recordId?: string
  project: string | null
  title: string | null
  status: string | null
  statusCategory: string | null
  source: string | null
  sourceProtocol: string | null
  capabilities: Capabilities | null
  engagedMs: number
  claudeTokens: number
  vendors: AgentSpend[]
  activeAgents: string[]
  workingNow: boolean
  updatedAt: string | null
  closedAt: string | null
  intervals: number
  lastAt: number
}

export const intervalEndMs = (row: { end_at: string; open: number }, now: number) =>
  row.open ? Math.max(now, new Date(row.end_at).getTime()) : new Date(row.end_at).getTime()

function foldVendors(rows: IntervalRow[]): AgentSpend[] {
  const by = new Map<string, AgentSpend>()
  for (const row of rows) {
    if (row.source !== 'orch' || !row.agent) continue
    const current = by.get(row.agent) ?? { agent: row.agent, tokens: 0, costUsd: null, runs: 0 }
    current.tokens += row.vendor_tokens
    current.runs += 1
    if (row.vendor_cost_usd != null) current.costUsd = (current.costUsd ?? 0) + row.vendor_cost_usd
    by.set(row.agent, current)
  }
  return [...by.values()].sort((a, b) => b.tokens - a.tokens)
}

/** The one identity formula shared by hosted, local, and unattributed task evidence. */
export function taskIdentity(row: {
  spaceId?: string
  recordId?: string | null
  key: string | null
  project?: string | null
}) {
  if (row.spaceId) return `${row.spaceId}\0${row.key ?? ''}`
  return row.recordId ?? `unattributed:${row.project ?? 'unknown'}:${row.key ?? ''}`
}

export function projectTasksInWindow(
  rows: WindowIntervalRow[],
  projectRows: ProjectionProject[],
  now: number,
): ProjectedTask[] {
  const groups = new Map<string, WindowIntervalRow[]>()
  for (const row of rows) {
    const id = taskIdentity({
      spaceId: row.space_id,
      recordId: row.task_record_id,
      key: row.task_key,
      project: row.project,
    })
    groups.set(id, [...(groups.get(id) ?? []), row])
  }
  const project = (spaceId: string | undefined, name: string | null) =>
    projectRows.find((item) => item.spaceId === spaceId && item.name === name) ?? null
  const output: ProjectedTask[] = []
  for (const list of groups.values()) {
    const first = list[0]!
    const key = first.task_key
    const spans: Span[] = list.map((row) => ({
      start: new Date(row.start_at).getTime(),
      end: intervalEndMs(row, now),
    }))
    const projectName = first.task_project ?? first.project
    const source = first.task_source ?? (key ? 'git' : null)
    output.push({
      spaceId: first.space_id,
      spaceName: first.space_name,
      key,
      ...(first.task_record_id ? { recordId: first.task_record_id } : {}),
      project: projectName,
      title: first.task_title,
      status: first.task_status,
      statusCategory: first.task_status_category,
      source,
      sourceProtocol:
        source === 'mcp'
          ? (project(first.space_id, projectName)?.settings.tracker?.protocol ?? null)
          : null,
      capabilities: key
        ? trackerCapabilities({
            source: source as TrackerRowSource,
            project: project(first.space_id, projectName),
          })
        : null,
      engagedMs: engagedMs(spans),
      claudeTokens: list.reduce((sum, row) => sum + row.claude_tokens, 0),
      vendors: foldVendors(list),
      activeAgents: [
        ...new Set(list.filter((row) => row.agent && row.open).map((row) => row.agent!)),
      ],
      workingNow: list.some(
        (row) => row.open || intervalEndMs(row, now) >= now - DEFAULT_IDLE_CAP_MS,
      ),
      updatedAt: first.task_updated_at,
      closedAt: first.task_closed_at,
      intervals: list.length,
      lastAt: Math.max(...spans.map((span) => span.end)),
    })
  }
  return output.sort((a, b) => b.lastAt - a.lastAt)
}

export type CompletedRow = {
  space_id?: string
  key: string
  task_record_id?: string
  project: string
  title: string | null
  at: string
  to_status: string
}

export type TaskRun = {
  id: number | string
  agent: string | null
  job: string | null
  start: string
  ms: number
  running: boolean
  tokens: number
  costUsd: number | null
}

function projectRuns(rows: IntervalRow[], now: number): TaskRun[] {
  return rows
    .filter((row) => row.source === 'orch')
    .map((row) => ({
      id: row.ref ? (runRef(row.ref)?.root ?? 0) : 0,
      agent: row.agent,
      job: row.job,
      start: row.start_at,
      ms: intervalEndMs(row, now) - new Date(row.start_at).getTime(),
      running: Boolean(row.open),
      tokens: row.vendor_tokens,
      costUsd: row.vendor_cost_usd,
    }))
    .sort((a, b) => Number(b.running) - Number(a.running) || b.start.localeCompare(a.start))
}

const sourceMatches = (row: { source: string | null; project: string | null }, source: string) =>
  !source ||
  (source === 'hub' ? row.source === 'local' : row.source !== 'local' && row.project === source)

export function projectFlightDone(input: {
  name: 'flight' | 'done'
  tasks: ProjectedTask[]
  completed: CompletedRow[]
  intervals: IntervalRow[]
  filters: { agent: string; project: string; source: string }
  projects: ProjectionProject[]
  now: number
}) {
  const all = input.tasks
  const rows = all.filter(
    (row) =>
      (!input.filters.project || row.project === input.filters.project) &&
      sourceMatches(row, input.filters.source),
  )
  const closed = new Set(
    input.completed.map((row) =>
      taskIdentity({
        spaceId: row.space_id,
        recordId: row.task_record_id,
        key: row.key,
        project: row.project,
      }),
    ),
  )
  const inFlight = (row: ProjectedTask) =>
    row.workingNow || ['active', 'review'].includes(row.statusCategory ?? '')
  const wanted =
    input.name === 'done'
      ? rows.filter(
          (row) => row.key && (closed.has(taskIdentity(row)) || row.statusCategory === 'done'),
        )
      : rows.filter(inFlight)
  const unmapped = rows.filter(
    (row) => row.source === 'mcp' && row.status && !row.statusCategory && !wanted.includes(row),
  )
  const dropped: { reason: string; tasks: number; engaged: string }[] = []
  if (input.name === 'flight') {
    const groups: [string, (row: ProjectedTask) => boolean][] = [
      [
        'no tracker reachable to say whether they are active',
        (row) => !!row.key && !row.statusCategory && !(row.source === 'mcp' && row.status),
      ],
      [
        'queued in their tracker: backlog, todo or unstarted',
        (row) => row.statusCategory === 'open',
      ],
    ]
    for (const [reason, match] of groups) {
      const hit = rows.filter((row) => match(row) && !inFlight(row))
      if (hit.length)
        dropped.push({
          reason,
          tasks: hit.length,
          engaged: human(hit.reduce((sum, row) => sum + row.engagedMs, 0)),
        })
    }
  }
  const shaped = wanted.map((row) => ({
    ...row,
    engaged: human(row.engagedMs),
    runs: row.key
      ? projectRuns(
          input.intervals.filter(
            (item) =>
              taskIdentity({
                spaceId: item.space_id,
                recordId: item.task_record_id,
                key: item.task_key,
                project: item.project,
              }) === taskIdentity(row),
          ),
          input.now,
        )
      : [],
  }))
  const kept = input.filters.agent
    ? shaped.filter((row) => row.runs.some((run) => run.agent === input.filters.agent))
    : shaped
  const strings = (values: (string | null | undefined)[]) =>
    [...new Set(values.filter((value): value is string => Boolean(value)))].sort()
  const sources = strings([
    'hub',
    ...input.projects.filter((item) => item.settings.tracker).map((item) => item.name),
    ...all.filter((row) => row.source !== 'local').map((row) => row.project),
  ])
  return {
    rows: kept,
    dropped,
    unmappedStatuses: { count: unmapped.length, words: strings(unmapped.map((row) => row.status)) },
    filters: input.filters,
    matched: kept.length,
    facets: {
      projects: strings(all.map((row) => row.project)),
      agents: strings(shaped.flatMap((row) => row.runs.map((run) => run.agent))),
      sources,
    },
  }
}

export type BoardSourceRow = {
  space_id?: string
  space_name?: string
  key: string
  record_id?: string | null
  project: string | null
  title: string | null
  assignee: string | null
  status: string | null
  status_category: string | null
  source: string
  updated_at: string | null
  last_seen: string
}

export function projectBoardCards(
  rows: BoardSourceRow[],
  liveKeys: string[],
  projectRows: ProjectionProject[],
) {
  const live = new Set(liveKeys)
  return rows.map((row) => {
    const project =
      projectRows.find((item) => item.spaceId === row.space_id && item.name === row.project) ?? null
    const identity = taskIdentity({
      spaceId: row.space_id,
      recordId: row.record_id,
      key: row.key,
      project: row.project,
    })
    return {
      spaceId: row.space_id,
      spaceName: row.space_name,
      key: row.key,
      ...(row.record_id ? { recordId: row.record_id } : {}),
      project: row.project,
      title: row.title,
      assignee: row.assignee,
      status: row.status,
      statusCategory: row.status_category,
      source: row.source,
      sourceProtocol: row.source === 'mcp' ? (project?.settings.tracker?.protocol ?? null) : null,
      capabilities: trackerCapabilities({ source: row.source as TrackerRowSource, project }),
      updatedAt: row.updated_at ?? row.last_seen,
      workingNow: live.has(identity),
    }
  })
}

export function projectBoard(input: {
  rows: BoardSourceRow[]
  recentKeys: string[]
  liveKeys: string[]
  projects: ProjectionProject[]
  cap: number
}) {
  const recent = new Set(input.recentKeys)
  const eligible = input.rows.filter(
    (row) =>
      ['active', 'review'].includes(row.status_category ?? '') ||
      recent.has(
        taskIdentity({
          spaceId: row.space_id,
          recordId: row.record_id,
          key: row.key,
          project: row.project,
        }),
      ) ||
      (row.source === 'local' && !['done', 'dropped'].includes(row.status_category ?? '')),
  )
  const count = (bucket: (row: BoardSourceRow) => string) =>
    eligible.reduce<Record<string, number>>((out, row) => {
      const key = bucket(row)
      out[key] = (out[key] ?? 0) + 1
      return out
    }, {})
  const rank = (status: string | null) =>
    status === 'active'
      ? 0
      : status === 'review'
        ? 1
        : status === 'done'
          ? 3
          : status === 'dropped'
            ? 4
            : 2
  const rows = [...eligible]
    .sort(
      (a, b) =>
        rank(a.status_category) - rank(b.status_category) ||
        (b.updated_at ?? b.last_seen).localeCompare(a.updated_at ?? a.last_seen),
    )
    .slice(0, input.cap)
  return {
    cards: projectBoardCards(rows, input.liveKeys, input.projects),
    totals: {
      status: count((row) => row.status_category ?? 'unknown'),
      project: count((row) => row.project ?? 'elsewhere'),
    },
    cap: input.cap,
  }
}
