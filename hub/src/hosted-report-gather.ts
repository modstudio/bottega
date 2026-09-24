// concern: hosted-report-gather
/** Builds the existing report projection from hosted record rows. */

import { engagedMs, human } from '../../shared/interval.ts'
import { hostedTaskJoin } from './hosted-task-reference.ts'
import { type TaskIdentity, withHostedTenant } from './hosted-tasks.ts'
import type { MeasureScope } from './measures.ts'
import type { DeliveryPeriod } from './report-delivery.ts'
import type { GatheredReport, Item } from './report-renderer.ts'

type SqlTime = string | Date
const iso = (value: SqlTime) => new Date(value).toISOString()
const number = (value: string | number | bigint | null | undefined) => Number(value ?? 0)
const rows = <T>(value: unknown) => value as T[]

export type HostedReportRow = {
  space_id: string
  task_id: string | null
  task_key: string | null
  project_name: string | null
  start_at: string
  end_at: string
  open: number
  vendor_tokens: number
  task_project: string | null
  task_title: string | null
  task_status: string | null
  project_color: string | null
}

type RawReportRow = Omit<HostedReportRow, 'start_at' | 'end_at' | 'open' | 'vendor_tokens'> & {
  start_at: SqlTime
  end_at: SqlTime
  open: string | number
  vendor_tokens: string | number
}

function span(row: HostedReportRow, period: DeliveryPeriod) {
  const from = new Date(period.from).getTime()
  const to = new Date(period.to).getTime()
  return {
    start: Math.max(from, new Date(row.start_at).getTime()),
    end: Math.min(to, row.open ? to : new Date(row.end_at).getTime()),
  }
}

export function gatherHostedReport(
  sourceRows: HostedReportRow[],
  closedTaskIds: ReadonlySet<string>,
  period: DeliveryPeriod,
): GatheredReport {
  const usable = sourceRows.filter((row) => (row.task_project ?? row.project_name) !== null)
  const groups = new Map<string, HostedReportRow[]>()
  for (const row of usable) {
    const project = row.task_project ?? row.project_name!
    const id = row.task_id ?? `\0untasked:${row.space_id}:${project}`
    groups.set(id, [...(groups.get(id) ?? []), row])
  }

  const projected = [...groups.values()].map((grouped) => {
    const first = grouped[0]!
    const key = first.task_key
    const project = first.task_project ?? first.project_name!
    const itemSpans = grouped.map((row) => span(row, period))
    const engaged = engagedMs(itemSpans)
    const item: Item = {
      key,
      project,
      title: key ? first.task_title : null,
      status: key ? first.task_status : null,
      closed: first.task_id ? closedTaskIds.has(first.task_id) : false,
      engaged: human(engaged),
      engagedMs: engaged,
      agentTokens: grouped.reduce((sum, row) => sum + row.vendor_tokens, 0),
    }
    return { item, rows: grouped }
  })
  projected.sort((left, right) => right.item.engagedMs - left.item.engagedMs)
  const items = projected.map(({ item }) => item)
  const projects = [...new Set(items.map((item) => item.project))]
    .map((project) => {
      const mine = projected.filter(({ item }) => item.project === project)
      const tasks = mine.map(({ item }) => item).filter((item) => item.key)
      const untasked = mine.map(({ item }) => item).find((item) => !item.key) ?? null
      return {
        project,
        color: mine.find(({ rows }) => rows[0]?.project_color)?.rows[0]?.project_color ?? null,
        taskMs: tasks.reduce((sum, item) => sum + item.engagedMs, 0),
        engagedMs: engagedMs(
          mine.flatMap(({ rows: grouped }) => grouped.map((row) => span(row, period))),
        ),
        shipped: tasks.filter((item) => item.closed).length,
        moving: tasks.filter((item) => !item.closed).length,
        agentTokens: mine.reduce((sum, { item }) => sum + item.agentTokens, 0),
        items: tasks,
        untasked,
      }
    })
    .sort((left, right) => right.engagedMs - left.engagedMs)

  return {
    from: period.from,
    to: period.to,
    hours: (new Date(period.to).getTime() - new Date(period.from).getTime()) / 3_600_000,
    items,
    taskMs: items.filter((item) => item.key).reduce((sum, item) => sum + item.engagedMs, 0),
    engagedMs: engagedMs(usable.map((row) => span(row, period))),
    projects,
  }
}

export async function hostedGatherReport(
  databaseUrl: string,
  identity: TaskIdentity,
  period: DeliveryPeriod,
  scope: MeasureScope,
) {
  return withHostedTenant(databaseUrl, identity, async (tx) => {
    const project =
      scope.kind === 'project'
        ? scope.project
        : scope.kind === 'person'
          ? (scope.project ?? null)
          : null
    const person = scope.kind === 'person' ? scope.userId : null
    const members = scope.kind === 'members' ? scope.userIds : null
    const reportRows = rows<RawReportRow>(
      await tx`
      SELECT i.space_id,t.id AS task_id,i.task_key,i.project_name,i.start_at,i.end_at,i.open,i.vendor_tokens,
        t.project AS task_project,t.title AS task_title,t.status AS task_status,p.color AS project_color
      FROM hub_interval i
      LEFT JOIN hub_task t ON t.space_id=i.space_id AND t.key=i.task_key AND t.deleted_at IS NULL
      LEFT JOIN project p ON p.space_id=i.space_id
        AND p.name=COALESCE(t.project,i.project_name) AND p.retired_at IS NULL
      WHERE i.start_at < ${period.to}::timestamptz AND i.end_at >= ${period.from}::timestamptz
        AND (${project}::text IS NULL OR COALESCE(t.project,i.project_name)=${project})
        AND (${person}::uuid IS NULL OR i.user_id=${person}::uuid)
        AND (${members}::uuid[] IS NULL OR i.user_id = ANY(${members}::uuid[]))
      ORDER BY i.start_at`,
    ).map((row) => ({
      ...row,
      start_at: iso(row.start_at),
      end_at: iso(row.end_at),
      open: number(row.open),
      vendor_tokens: number(row.vendor_tokens),
    }))
    const completed = rows<{ task_id: string }>(
      await tx`
      SELECT t.id AS task_id FROM hub_task_status_event e
      JOIN hub_task t ON ${hostedTaskJoin(tx, 'e')}
      WHERE e.deleted_at IS NULL AND t.deleted_at IS NULL AND e.to_status='done'
        AND e.at >= ${period.from}::timestamptz AND e.at < ${period.to}::timestamptz
        AND (${project}::text IS NULL OR t.project=${project})`,
    )
    return gatherHostedReport(reportRows, new Set(completed.map((row) => row.task_id)), period)
  })
}
