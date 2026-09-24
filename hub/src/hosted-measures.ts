import { hostedTaskJoin } from './hosted-task-reference.ts'
import { type TaskIdentity, withHostedTenant } from './hosted-tasks.ts'
import {
  computeMeasures,
  type MeasureInterval,
  type MeasureScope,
  type MeasureStatusEvent,
  type Measures,
  type MeasureWindow,
} from './measures.ts'

type SqlTime = string | Date
const iso = (value: SqlTime) => new Date(value).toISOString()
const number = (value: string | number | bigint | null | undefined) => Number(value ?? 0)
const rows = <T>(value: unknown) => value as T[]

type RawInterval = {
  task_id: string | null
  task_key: string | null
  project_name: string | null
  source: string
  start_at: SqlTime
  end_at: SqlTime
  open: string | number
  user_id: string | null
  vendor_tokens: string | number
  vendor_cost_usd: string | number | null
}

type RawEvent = {
  task_id: string
  task_key: string
  project: string
  at: SqlTime
  to_status: string
}

function asInterval(row: RawInterval): MeasureInterval {
  return {
    source: row.source,
    startAt: iso(row.start_at),
    endAt: iso(row.end_at),
    open: number(row.open),
    userId: row.user_id,
    taskId: row.task_id,
    taskKey: row.task_key,
    project: row.project_name,
    vendorTokens: number(row.vendor_tokens),
    vendorCostUsd: row.vendor_cost_usd == null ? null : Number(row.vendor_cost_usd),
  }
}

function asEvent(row: RawEvent): MeasureStatusEvent {
  return {
    taskId: row.task_id,
    taskKey: row.task_key,
    project: row.project,
    at: iso(row.at),
    toStatus: row.to_status,
  }
}

export async function loadHostedMeasureRows(
  databaseUrl: string,
  identity: TaskIdentity,
  window: MeasureWindow,
) {
  return withHostedTenant(databaseUrl, identity, async (tx) => {
    const events = rows<RawEvent>(
      await tx`
      SELECT t.id AS task_id, e.task_key, t.project, e.at, e.to_status
      FROM hub_task_status_event e
      JOIN hub_task t ON ${hostedTaskJoin(tx, 'hub_task_status_event', 'e')}
      WHERE e.deleted_at IS NULL AND t.deleted_at IS NULL
        AND e.at >= ${window.from}::timestamptz AND e.at < ${window.to}::timestamptz
        AND e.to_status='done'`,
    ).map(asEvent)
    const shippedIds = [...new Set(events.map((event) => event.taskId))]
    const overlapping = rows<RawInterval>(
      await tx`
      SELECT t.id AS task_id, i.task_key, i.project_name, i.source, i.start_at, i.end_at, i.open, i.user_id,
        i.vendor_tokens, i.vendor_cost_usd
      FROM hub_interval i
      LEFT JOIN hub_task t ON t.space_id=i.space_id AND t.key=i.task_key AND t.deleted_at IS NULL
      WHERE i.start_at < ${window.to}::timestamptz AND i.end_at >= ${window.from}::timestamptz`,
    )
    const earlier = shippedIds.length
      ? rows<RawInterval>(
          await tx`
          SELECT t.id AS task_id, i.task_key, i.project_name, i.source, i.start_at, i.end_at, i.open, i.user_id,
            i.vendor_tokens, i.vendor_cost_usd
          FROM hub_interval i
          JOIN hub_task t ON t.space_id=i.space_id AND t.key=i.task_key AND t.deleted_at IS NULL
          WHERE t.id IN ${tx(shippedIds)} AND i.start_at < ${window.from}::timestamptz`,
        )
      : []
    return { intervals: [...overlapping, ...earlier].map(asInterval), events }
  })
}

export async function hostedMeasures(
  databaseUrl: string,
  identity: TaskIdentity,
  window: MeasureWindow,
  scope: MeasureScope,
): Promise<Measures> {
  return computeMeasures(await loadHostedMeasureRows(databaseUrl, identity, window), window, scope)
}

export type HostedMeasurePerson = { userId: string; name: string; email: string }

/** Members with attributed evidence in this window; this is not a user directory. */
export async function hostedMeasurePeople(
  databaseUrl: string,
  identity: TaskIdentity,
  window: MeasureWindow,
  project?: string,
): Promise<HostedMeasurePerson[]> {
  return withHostedTenant(databaseUrl, identity, async (tx) =>
    rows<{ user_id: string; name: string; email: string }>(
      await tx`
      SELECT DISTINCT u.id AS user_id,u.name,u.email
      FROM hub_interval i
      JOIN membership m ON m.space_id=i.space_id AND m.user_id=i.user_id
      JOIN "user" u ON u.id=m.user_id
      WHERE i.space_id=${identity.spaceId}::uuid
        AND i.user_id IS NOT NULL
        AND i.start_at < ${window.to}::timestamptz AND i.end_at >= ${window.from}::timestamptz
        AND (${project ?? null}::text IS NULL OR i.project_name=${project ?? null})
      ORDER BY COALESCE(NULLIF(u.name,''),u.email),u.email,u.id`,
    ).map((row) => ({ userId: row.user_id, name: row.name || row.email, email: row.email })),
  )
}
